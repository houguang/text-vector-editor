//! 文字轮廓化：ttf-parser 解析字形 outline，转换为「节点 + 控制柄」结构。
//!
//! 关键点：
//! 1. 字形 outline 只有 M/L/Q/C/Z 四类命令，这里统一转换为三次贝塞尔节点表示，
//!    二次曲线按 c1 = p0 + 2/3(q-p0)、c2 = p2 + 2/3(q-p2) 升阶。
//! 2. 字体坐标 y 轴向上，设计坐标 y 轴向下，转换时统一取反。
//! 3. 字体文件字节流按路径缓存，避免每次转换都重新读取几十 MB 的 .ttc。

use crate::geom::{cubic_at, BBox, Bounds, Node, Pt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use ttf_parser::{Face, GlyphId, OutlineBuilder};

const SEG_SAMPLES: usize = 16;

#[derive(Clone, Debug, Serialize)]
pub struct Contour {
    pub nodes: Vec<Node>,
    pub closed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shape {
    pub ch: String,
    pub line: usize,
    pub char_index: usize,
    pub contours: Vec<Contour>,
    pub bbox: BBox,
    pub advance: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub shapes: usize,
    pub contours: usize,
    pub nodes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineRequest {
    pub text: String,
    pub font_path: String,
    #[serde(default)]
    pub face_index: u32,
    pub size: f64,
    #[serde(default = "one")]
    pub width_scale: f64,
    #[serde(default)]
    pub slant_deg: f64,
    #[serde(default)]
    pub letter_spacing: f64,
    #[serde(default)]
    pub baseline_y: f64,
    #[serde(default)]
    pub offset_x: f64,
    #[serde(default)]
    pub line_index: usize,
    #[serde(default)]
    pub start_index: usize,
}

fn one() -> f64 {
    1.0
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineResponse {
    pub shapes: Vec<Shape>,
    pub bbox: BBox,
    pub stats: Stats,
    pub missing: Vec<String>,
    pub advance: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureRequest {
    pub text: String,
    pub font_path: String,
    #[serde(default)]
    pub face_index: u32,
    pub size: f64,
    #[serde(default = "one")]
    pub width_scale: f64,
    #[serde(default)]
    pub letter_spacing: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureResponse {
    pub line_widths: Vec<f64>,
    pub max_width: f64,
    pub ascent: f64,
    pub descent: f64,
    pub units_per_em: f64,
    pub missing: Vec<String>,
}

// ---------------------------------------------------------------- 字体字节缓存

static FONT_DATA: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();

fn font_data(path: &str) -> Result<Arc<Vec<u8>>, String> {
    let cache = FONT_DATA.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(d) = guard.get(path) {
            return Ok(d.clone());
        }
    }
    let bytes = std::fs::read(path).map_err(|e| format!("无法读取字体文件：{path}（{e}）"))?;
    if bytes.len() < 4 {
        return Err(format!("字体文件内容为空：{path}"));
    }
    let arc = Arc::new(bytes);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(path.to_string(), arc.clone());
    }
    Ok(arc)
}

// ---------------------------------------------------------------- outline 收集

enum El {
    Move(Pt),
    Line(Pt),
    Quad(Pt, Pt),
    Cubic(Pt, Pt, Pt),
    Close,
}

struct Collector {
    els: Vec<El>,
}

impl OutlineBuilder for Collector {
    fn move_to(&mut self, x: f32, y: f32) {
        self.els.push(El::Move(Pt::new(x as f64, y as f64)));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.els.push(El::Line(Pt::new(x as f64, y as f64)));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.els.push(El::Quad(Pt::new(x1 as f64, y1 as f64), Pt::new(x as f64, y as f64)));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.els.push(El::Cubic(
            Pt::new(x1 as f64, y1 as f64),
            Pt::new(x2 as f64, y2 as f64),
            Pt::new(x as f64, y as f64),
        ));
    }
    fn close(&mut self) {
        self.els.push(El::Close);
    }
}

fn flush(nodes: &mut Vec<Node>, closed: bool, out: &mut Vec<Contour>) {
    if nodes.len() >= 2 {
        let mut ns = std::mem::take(nodes);
        if closed && ns.len() > 2 {
            let last = ns[ns.len() - 1].clone();
            let (fx, fy) = (ns[0].x, ns[0].y);
            if (last.x - fx).abs() < 1e-6 && (last.y - fy).abs() < 1e-6 {
                // 首尾重合点合并：把闭合段的入控制柄交给首节点
                ns.pop();
                ns[0].in_h = last.in_h;
            }
        }
        out.push(Contour { nodes: ns, closed });
    } else {
        nodes.clear();
    }
}

fn build_contours(els: &[El]) -> Vec<Contour> {
    let mut out: Vec<Contour> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut cur = Pt::new(0.0, 0.0);

    for el in els {
        match el {
            El::Move(p) => {
                flush(&mut nodes, false, &mut out);
                nodes.push(Node { x: p.x, y: p.y, in_h: None, out_h: None });
                cur = *p;
            }
            El::Line(p) => {
                nodes.push(Node { x: p.x, y: p.y, in_h: None, out_h: None });
                cur = *p;
            }
            El::Quad(c, p) => {
                let c1 = Pt::new(cur.x + 2.0 / 3.0 * (c.x - cur.x), cur.y + 2.0 / 3.0 * (c.y - cur.y));
                let c2 = Pt::new(p.x + 2.0 / 3.0 * (c.x - p.x), p.y + 2.0 / 3.0 * (c.y - p.y));
                if let Some(n) = nodes.last_mut() {
                    n.out_h = Some(c1);
                }
                nodes.push(Node { x: p.x, y: p.y, in_h: Some(c2), out_h: None });
                cur = *p;
            }
            El::Cubic(a, b, p) => {
                if let Some(n) = nodes.last_mut() {
                    n.out_h = Some(*a);
                }
                nodes.push(Node { x: p.x, y: p.y, in_h: Some(*b), out_h: None });
                cur = *p;
            }
            El::Close => {
                flush(&mut nodes, true, &mut out);
            }
        }
    }
    flush(&mut nodes, false, &mut out);
    out
}

// ---------------------------------------------------------------- 度量辅助

fn kerning(face: &Face, left: GlyphId, right: GlyphId) -> f64 {
    if let Some(kern) = face.tables().kern {
        for st in kern.subtables {
            if let Some(k) = st.glyphs_kerning(left, right) {
                return k as f64;
            }
        }
    }
    0.0
}

struct LineMetrics {
    /// (字符, 字形, 该字前进量（含字距与字偶距）)
    items: Vec<(char, Option<GlyphId>, f64)>,
    width: f64,
}

fn layout_line(face: &Face, line: &str, sx: f64, spacing: f64) -> LineMetrics {
    let mut items = Vec::new();
    let mut prev: Option<GlyphId> = None;
    let mut width = 0.0;
    for ch in line.chars() {
        let gid = face.glyph_index(ch);
        let adv = match gid {
            Some(g) => {
                let base = face.glyph_hor_advance(g).unwrap_or(0) as f64 * sx;
                let k = prev.map(|p| kerning(face, p, g)).unwrap_or(0.0) * sx;
                base + k + spacing
            }
            // 缺字符时按半角宽度占位，避免后续字符重叠
            None => face.units_per_em() as f64 * 0.5 * sx + spacing,
        };
        width += adv;
        items.push((ch, gid, adv));
        prev = gid;
    }
    LineMetrics { items, width }
}

fn transform_node(n: &Node, sx: f64, sy: f64, slant: f64, ox: f64, oy: f64) -> Node {
    let tf = |p: Pt| Pt::new(ox + (p.x + p.y * slant) * sx, oy - p.y * sy);
    Node {
        x: ox + (n.x + n.y * slant) * sx,
        y: oy - n.y * sy,
        in_h: n.in_h.map(tf),
        out_h: n.out_h.map(tf),
    }
}

fn contour_bounds(nodes: &[Node], closed: bool) -> Bounds {
    let mut b = Bounds::new();
    if nodes.is_empty() {
        return b;
    }
    let n = nodes.len();
    let last = if closed { n } else { n.saturating_sub(1) };
    for i in 0..last {
        let a = &nodes[i];
        let bb = &nodes[(i + 1) % n];
        let p0 = Pt::new(a.x, a.y);
        let p3 = Pt::new(bb.x, bb.y);
        let c1 = a.out_h.unwrap_or(p0);
        let c2 = bb.in_h.unwrap_or(p3);
        b.add(p0.x, p0.y);
        for s in 1..=SEG_SAMPLES {
            let p = cubic_at(p0, c1, c2, p3, s as f64 / SEG_SAMPLES as f64);
            b.add(p.x, p.y);
        }
    }
    if n == 1 {
        b.add(nodes[0].x, nodes[0].y);
    }
    b
}

// ---------------------------------------------------------------- 命令实现

#[tauri::command]
pub async fn outline_text(req: OutlineRequest) -> Result<OutlineResponse, String> {
    tauri::async_runtime::spawn_blocking(move || outline_impl(req))
        .await
        .map_err(|e| format!("轮廓化线程异常：{e}"))?
}

#[tauri::command]
pub async fn measure_text(req: MeasureRequest) -> Result<MeasureResponse, String> {
    tauri::async_runtime::spawn_blocking(move || measure_impl(req))
        .await
        .map_err(|e| format!("度量线程异常：{e}"))?
}

fn measure_impl(req: MeasureRequest) -> Result<MeasureResponse, String> {
    let data = font_data(&req.font_path)?;
    let face = Face::parse(data.as_slice(), req.face_index)
        .map_err(|e| format!("字体解析失败：{e:?}（文件：{}）", req.font_path))?;
    let upem = face.units_per_em() as f64;
    if upem <= 0.0 {
        return Err("字体 unitsPerEm 非法（0）".into());
    }
    let sy = req.size / upem;
    let sx = sy * if req.width_scale > 0.0 { req.width_scale } else { 1.0 };
    let mut widths = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut max_width: f64 = 0.0;
    for line in req.text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        let m = layout_line(&face, line, sx, req.letter_spacing);
        for (ch, gid, _) in &m.items {
            if gid.is_none() && !ch.is_whitespace() {
                let s = ch.to_string();
                if !missing.contains(&s) {
                    missing.push(s);
                }
            }
        }
        max_width = max_width.max(m.width);
        widths.push(m.width);
    }
    Ok(MeasureResponse {
        line_widths: widths,
        max_width,
        ascent: face.ascender() as f64 * sy,
        descent: face.descender() as f64 * sy,
        units_per_em: upem,
        missing,
    })
}

fn outline_impl(req: OutlineRequest) -> Result<OutlineResponse, String> {
    let data = font_data(&req.font_path)?;
    let face = Face::parse(data.as_slice(), req.face_index)
        .map_err(|e| format!("字体解析失败：{e:?}（文件：{}）", req.font_path))?;
    let upem = face.units_per_em() as f64;
    if upem <= 0.0 {
        return Err("字体 unitsPerEm 非法（0）".into());
    }
    let sy = req.size / upem;
    let sx = sy * if req.width_scale > 0.0 { req.width_scale } else { 1.0 };
    let slant = req.slant_deg.to_radians().tan();

    let line: String = req.text.replace("\r\n", "\n").replace('\r', "\n").replace('\n', " ");
    let metrics = layout_line(&face, &line, sx, req.letter_spacing);

    let mut shapes: Vec<Shape> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let mut bounds = Bounds::new();
    let mut pen = req.offset_x;
    let mut stats = Stats { shapes: 0, contours: 0, nodes: 0 };

    for (i, (ch, gid, adv)) in metrics.items.iter().enumerate() {
        let advance = *adv;
        if let Some(g) = gid {
            let mut collector = Collector { els: Vec::new() };
            if face.outline_glyph(*g, &mut collector).is_some() && !collector.els.is_empty() {
                let raw = build_contours(&collector.els);
                let mut contours: Vec<Contour> = Vec::with_capacity(raw.len());
                let mut shape_bounds = Bounds::new();
                for c in raw {
                    let nodes: Vec<Node> = c
                        .nodes
                        .iter()
                        .map(|n| transform_node(n, sx, sy, slant, pen, req.baseline_y))
                        .collect();
                    let cb = contour_bounds(&nodes, c.closed);
                    let bb = cb.to_bbox();
                    if !bb.is_empty() {
                        shape_bounds.add(bb.x, bb.y);
                        shape_bounds.add(bb.x + bb.w, bb.y + bb.h);
                    }
                    stats.nodes += nodes.len();
                    stats.contours += 1;
                    contours.push(Contour { nodes, closed: c.closed });
                }
                if !contours.is_empty() {
                    let bb = shape_bounds.to_bbox();
                    if !bb.is_empty() {
                        bounds.add(bb.x, bb.y);
                        bounds.add(bb.x + bb.w, bb.y + bb.h);
                    }
                    stats.shapes += 1;
                    shapes.push(Shape {
                        ch: ch.to_string(),
                        line: req.line_index,
                        char_index: req.start_index + i,
                        contours,
                        bbox: bb,
                        advance,
                    });
                }
            }
        } else if !ch.is_whitespace() {
            let s = ch.to_string();
            if !missing.contains(&s) {
                missing.push(s);
            }
        }
        pen += advance;
    }

    Ok(OutlineResponse {
        shapes,
        bbox: bounds.to_bbox(),
        stats,
        missing,
        advance: metrics.width,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find_font() -> Option<String> {
        let dir = std::path::Path::new("C:/Windows/Fonts");
        for name in ["msyh.ttc", "msyhbd.ttc", "simsun.ttc", "simhei.ttf", "arial.ttf", "segoeui.ttf"] {
            let p = dir.join(name);
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
        None
    }

    #[test]
    fn outline_latin_and_cjk() {
        let Some(path) = find_font() else {
            eprintln!("skip: no system font found");
            return;
        };
        let resp = outline_impl(OutlineRequest {
            text: "Hello 世界".into(),
            font_path: path,
            face_index: 0,
            size: 120.0,
            width_scale: 1.0,
            slant_deg: 0.0,
            letter_spacing: 0.0,
            baseline_y: 200.0,
            offset_x: 0.0,
            line_index: 0,
            start_index: 0,
        })
        .expect("outline failed");

        println!(
            "shapes={} contours={} nodes={} bbox={:?} missing={:?}",
            resp.stats.shapes, resp.stats.contours, resp.stats.nodes, resp.bbox, resp.missing
        );
        assert!(resp.stats.shapes >= 6, "应至少生成 6 个字形，实际 {}", resp.stats.shapes);
        assert!(resp.stats.nodes > 50, "节点数过少：{}", resp.stats.nodes);
        assert!(resp.bbox.w > 100.0 && resp.bbox.h > 50.0, "包围盒异常：{:?}", resp.bbox);

        // 每个闭合轮廓至少 3 个节点，且首尾不重复
        for s in &resp.shapes {
            for c in &s.contours {
                assert!(c.nodes.len() >= 3, "轮廓节点过少: {}", c.nodes.len());
                let f = &c.nodes[0];
                let l = &c.nodes[c.nodes.len() - 1];
                let dup = (f.x - l.x).abs() < 1e-6 && (f.y - l.y).abs() < 1e-6;
                assert!(!dup, "闭合轮廓首尾节点重复未合并");
            }
        }

        // 空文本应返回空结果
        let empty = outline_impl(OutlineRequest {
            text: "".into(),
            font_path: find_font().unwrap(),
            face_index: 0,
            size: 120.0,
            width_scale: 1.0,
            slant_deg: 0.0,
            letter_spacing: 0.0,
            baseline_y: 0.0,
            offset_x: 0.0,
            line_index: 0,
            start_index: 0,
        })
        .expect("empty outline failed");
        assert_eq!(empty.stats.shapes, 0);
    }

    #[test]
    fn measure_lines() {
        let Some(path) = find_font() else { return };
        let resp = measure_impl(MeasureRequest {
            text: "Hello\n世界".into(),
            font_path: path,
            face_index: 0,
            size: 100.0,
            width_scale: 1.0,
            letter_spacing: 0.0,
        })
        .expect("measure failed");
        println!("widths={:?} ascent={} descent={}", resp.line_widths, resp.ascent, resp.descent);
        assert_eq!(resp.line_widths.len(), 2);
        assert!(resp.line_widths[0] > 0.0 && resp.line_widths[1] > 0.0);
        assert!(resp.ascent > 0.0);
    }
}
