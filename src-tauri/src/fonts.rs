//! 系统字体枚举。
//!
//! 说明：`tauri-plugin-system-fonts` 同样基于 fontdb，但它的返回值不含「字体集合内的面索引」，
//! 而 Windows 上大量中文字体是 .ttc 集合（msyh.ttc / simsun.ttc / simhei.ttf ...），
//! 缺少 index 会导致 ttf-parser 只能解析第 0 个面，选中「微软雅黑 Bold」时拿到的仍是 Regular。
//! 因此这里直接用 fontdb 自行枚举，额外提供 index，并保留插件作为兜底（见 capabilities）。

use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use ttf_parser::Language;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontEntry {
    /// 展示用族名（优先中文名）
    pub family: String,
    /// 英文族名，便于搜索
    pub family_en: String,
    /// 字重/字形后缀，如 Regular / Bold / Italic
    pub subfamily: String,
    pub post_script_name: String,
    pub path: String,
    /// .ttc 集合内的面索引
    pub index: u32,
    pub weight: u16,
    pub style: String,
    pub monospaced: bool,
}

static CACHE: OnceLock<Mutex<Option<Vec<FontEntry>>>> = OnceLock::new();

#[tauri::command]
pub async fn list_fonts(force: Option<bool>) -> Result<Vec<FontEntry>, String> {
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<FontEntry>, String> {
        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if !force {
            if let Ok(guard) = cache.lock() {
                if let Some(list) = guard.as_ref() {
                    return Ok(list.clone());
                }
            }
        }
        let list = scan()?;
        if let Ok(mut guard) = cache.lock() {
            *guard = Some(list.clone());
        }
        Ok(list)
    })
    .await
    .map_err(|e| format!("字体枚举线程异常：{e}"))?
}

fn pick_family(families: &[(String, Language)]) -> (String, String) {
    // fontdb 的 families 顺序不保证第一个就是英文名，优先选 ASCII 名作为 familyEn
    let en = families
        .iter()
        .find(|(name, _)| !name.is_empty() && name.is_ascii())
        .or_else(|| families.first())
        .map(|f| f.0.clone())
        .unwrap_or_default();
    let zh = families
        .iter()
        .find(|(_, lang)| {
            matches!(
                lang,
                Language::Chinese_PeoplesRepublicOfChina
                    | Language::Chinese_Taiwan
                    | Language::Chinese_HongKongSAR
                    | Language::Chinese_MacaoSAR
                    | Language::Chinese_Singapore
            )
        })
        .map(|f| f.0.clone());
    match zh {
        Some(name) if !name.is_empty() => (name, en),
        _ => (en.clone(), en),
    }
}

fn style_name(style: fontdb::Style) -> &'static str {
    match style {
        fontdb::Style::Normal => "Normal",
        fontdb::Style::Italic => "Italic",
        fontdb::Style::Oblique => "Oblique",
    }
}

fn subfamily(weight: u16, style: fontdb::Style) -> String {
    let italic = !matches!(style, fontdb::Style::Normal);
    let w = match weight {
        0..=149 => "Thin",
        150..=249 => "ExtraLight",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "SemiBold",
        650..=749 => "Bold",
        750..=849 => "ExtraBold",
        _ => "Black",
    };
    match (w, italic) {
        ("Regular", true) => "Italic".to_string(),
        ("Regular", false) => "Regular".to_string(),
        (w, true) => format!("{w} Italic"),
        (w, false) => w.to_string(),
    }
}

fn scan() -> Result<Vec<FontEntry>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    if db.len() == 0 {
        return Err("未扫描到任何系统字体，请确认 C:\\Windows\\Fonts 可访问".into());
    }

    let mut out: Vec<FontEntry> = Vec::new();
    let mut seen: HashSet<(String, String, String, u32)> = HashSet::new();

    for face in db.faces() {
        let path = match &face.source {
            fontdb::Source::File(p) => p.to_string_lossy().to_string(),
            _ => continue,
        };
        let (family, family_en) = pick_family(&face.families);
        // 过滤以 '.' 开头的隐藏字体（如 .AppleSystemUIFont）
        if family.is_empty() || family.starts_with('.') || family.starts_with('@') {
            continue;
        }
        let sub = subfamily(face.weight.0, face.style);
        let key = (family.clone(), sub.clone(), path.clone(), face.index);
        if !seen.insert(key) {
            continue;
        }
        out.push(FontEntry {
            family,
            family_en,
            subfamily: sub,
            post_script_name: face.post_script_name.clone(),
            path,
            index: face.index,
            weight: face.weight.0,
            style: style_name(face.style).to_string(),
            monospaced: face.monospaced,
        });
    }

    if out.is_empty() {
        return Err("未扫描到可用的字体文件".into());
    }

    out.sort_by(|a, b| {
        a.family
            .to_lowercase()
            .cmp(&b.family.to_lowercase())
            .then(a.weight.cmp(&b.weight))
            .then(a.subfamily.cmp(&b.subfamily))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_family_prefers_ascii_english_name() {
        let families = vec![
            ("微软雅黑".to_string(), Language::Chinese_PeoplesRepublicOfChina),
            ("Microsoft YaHei".to_string(), Language::English_UnitedStates),
        ];
        let (zh, en) = pick_family(&families);
        assert_eq!(zh, "微软雅黑");
        assert_eq!(en, "Microsoft YaHei");
    }

    #[test]
    fn scan_has_chinese_and_latin() {
        let list = scan().expect("scan failed");
        println!("total faces: {}", list.len());
        let has_cjk = list.iter().any(|f| f.family.contains("雅黑") || f.family.contains("宋") || f.family.contains("黑体"));
        let has_latin = list.iter().any(|f| f.family_en.eq_ignore_ascii_case("Arial") || f.family_en.eq_ignore_ascii_case("Segoe UI"));
        println!("sample: {:?}", list.iter().take(5).map(|f| (&f.family, &f.subfamily, f.index)).collect::<Vec<_>>());
        assert!(list.len() > 20, "字体数量过少: {}", list.len());
        assert!(has_cjk, "缺少中文字体");
        assert!(has_latin, "缺少英文字体");
        assert!(list.iter().all(|f| !f.path.is_empty()));
    }
}
