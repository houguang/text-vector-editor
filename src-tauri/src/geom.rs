//! 几何基础类型：点、节点、包围盒。
//!
//! 节点采用「三次贝塞尔」统一表示：每个节点持有绝对坐标的入/出控制点，
//! 这样前端做节点拖拽时只需要平移控制点，不必关心原始曲线类型。

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

impl Pt {
    pub fn new(x: f64, y: f64) -> Self {
        Pt { x, y }
    }
}

/// 路径节点。`in_h` / `out_h` 为绝对坐标的控制柄，直线段为 None。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Node {
    pub x: f64,
    pub y: f64,
    #[serde(rename = "in", default, skip_serializing_if = "Option::is_none")]
    pub in_h: Option<Pt>,
    #[serde(rename = "out", default, skip_serializing_if = "Option::is_none")]
    pub out_h: Option<Pt>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct BBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl BBox {
    pub fn empty() -> Self {
        BBox { x: 0.0, y: 0.0, w: 0.0, h: 0.0 }
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0.0 && self.h <= 0.0
    }
}

/// 包围盒累加器。
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    any: bool,
}

impl Default for Bounds {
    fn default() -> Self {
        Self::new()
    }
}

impl Bounds {
    pub fn new() -> Self {
        Bounds { min_x: f64::INFINITY, min_y: f64::INFINITY, max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY, any: false }
    }

    pub fn add(&mut self, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
        self.any = true;
    }

    pub fn to_bbox(&self) -> BBox {
        if !self.any {
            return BBox::empty();
        }
        BBox { x: self.min_x, y: self.min_y, w: self.max_x - self.min_x, h: self.max_y - self.min_y }
    }
}

/// 三次贝塞尔求值。
pub fn cubic_at(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: f64) -> Pt {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    Pt::new(
        a * p0.x + b * c1.x + c * c2.x + d * p3.x,
        a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    )
}
