//! 作品库：把工程（画布路径 + 笔画库 + 字体设置）存到应用数据目录，支持列表 / 读取 / 删除。
//!
//! 目录结构：
//!   <app_data>/projects/<id>.json        工程正文
//!   <app_data>/projects/<id>.meta.json   列表用的元信息（名称、时间、数量、缩略图）
//! 元信息单独存放，列表时不必读整份工程（单个工程可能几 MB）。

use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    /// 毫秒时间戳
    pub updated_at: u64,
    #[serde(default)]
    pub shapes: usize,
    #[serde(default)]
    pub strokes: usize,
    /// PNG dataURL，用于列表缩略图
    #[serde(default)]
    pub thumb: Option<String>,
}

fn projects_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("projects");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败 {}：{e}", dir.display()))?;
    Ok(dir)
}

/// 只允许字母数字、下划线、短横线，避免路径穿越
fn safe_id(id: &str) -> Result<&str, String> {
    if id.is_empty() || id.len() > 64 {
        return Err("工程 id 非法".into());
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("工程 id 含非法字符".into());
    }
    Ok(id)
}

#[tauri::command]
pub async fn list_projects(app: tauri::AppHandle) -> Result<Vec<ProjectMeta>, String> {
    let dir = projects_dir(&app)?;
    let mut out: Vec<ProjectMeta> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !name.ends_with(".meta.json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(meta) = serde_json::from_str::<ProjectMeta>(&text) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub async fn save_project(
    app: tauri::AppHandle,
    id: String,
    name: String,
    data: String,
    shapes: usize,
    strokes: usize,
    thumb: Option<String>,
) -> Result<ProjectMeta, String> {
    let id = safe_id(&id)?.to_string();
    let dir = projects_dir(&app)?;
    let name = if name.trim().is_empty() { "未命名".to_string() } else { name.trim().to_string() };

    let doc_path = dir.join(format!("{id}.json"));
    std::fs::write(&doc_path, data.as_bytes())
        .map_err(|e| format!("写入工程失败 {}：{e}", doc_path.display()))?;

    let meta = ProjectMeta {
        id: id.clone(),
        name,
        updated_at: now_ms(),
        shapes,
        strokes,
        thumb,
    };
    let meta_path = dir.join(format!("{id}.meta.json"));
    let json = serde_json::to_string(&meta).map_err(|e| format!("序列化元信息失败：{e}"))?;
    std::fs::write(&meta_path, json.as_bytes())
        .map_err(|e| format!("写入元信息失败 {}：{e}", meta_path.display()))?;

    Ok(meta)
}

#[tauri::command]
pub async fn load_project(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let id = safe_id(&id)?;
    let path = projects_dir(&app)?.join(format!("{id}.json"));
    std::fs::read_to_string(&path).map_err(|e| format!("读取工程失败：{e}"))
}

#[tauri::command]
pub async fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let dir = projects_dir(&app)?;
    for suffix in [".json", ".meta.json"] {
        let p = dir.join(format!("{id}{suffix}"));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| format!("删除失败 {}：{e}", p.display()))?;
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_ids() {
        assert!(safe_id("p123-abc").is_ok());
        assert!(safe_id("../evil").is_err());
        assert!(safe_id("a/b").is_err());
        assert!(safe_id("").is_err());
        assert!(safe_id("带中文").is_err());
    }

    #[test]
    fn meta_roundtrip() {
        let m = ProjectMeta {
            id: "p1".into(),
            name: "他".into(),
            updated_at: 1,
            shapes: 2,
            strokes: 1,
            thumb: Some("data:image/png;base64,AAA".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        assert!(s.contains("\"updatedAt\""));
        let back: ProjectMeta = serde_json::from_str(&s).unwrap();
        assert_eq!(back.name, "他");
        assert_eq!(back.shapes, 2);
    }
}
