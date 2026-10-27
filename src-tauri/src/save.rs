//! SVG 导出：原生保存对话框（tauri-plugin-dialog）+ 文件写入。

use tauri_plugin_dialog::DialogExt;

/// 通过原生「另存为」对话框导出 SVG。返回写入的绝对路径；用户取消时返回 Ok(None)。
#[tauri::command]
pub async fn save_svg(
    app: tauri::AppHandle,
    svg: String,
    default_name: String,
) -> Result<Option<String>, String> {
    if svg.trim().is_empty() {
        return Err("SVG 内容为空，已取消导出".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("导出 SVG")
        .set_file_name(&default_name)
        .add_filter("SVG 矢量图形", &["svg"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    // 在阻塞线程池等待对话框回调，避免占住 async worker
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("保存对话框线程异常：{e}"))?
        .map_err(|e| format!("保存对话框异常：{e}"))?;
    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path.into_path().map_err(|e| format!("路径无效：{e}"))?;
    write_svg(&path, &svg)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

fn write_svg(path: &std::path::Path, svg: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
        }
    }
    std::fs::write(path, svg.as_bytes()).map_err(|e| format!("写入失败 {}：{e}", path.display()))
}

/// 只选择文件夹（用于预先设置批量导出目录），不写任何文件。
#[tauri::command]
pub async fn choose_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择笔画导出文件夹")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("文件夹选择线程异常：{e}"))?
        .map_err(|e| format!("文件夹选择异常：{e}"))?;
    let Some(dir) = picked else {
        return Ok(None);
    };
    let dir = dir.into_path().map_err(|e| format!("路径无效：{e}"))?;
    Ok(Some(dir.to_string_lossy().to_string()))
}

// ---------------------------------------------------------------- 笔画批量导出

#[derive(Debug, serde::Deserialize)]
pub struct OutFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResult {
    pub folder: String,
    pub count: usize,
    pub names: Vec<String>,
}

/// 批量导出：选择一个文件夹，每个笔画写一个 `<名称>.svg`。
#[tauri::command]
pub async fn save_svgs_dialog(
    app: tauri::AppHandle,
    files: Vec<OutFile>,
) -> Result<Option<BatchResult>, String> {
    if files.is_empty() {
        return Err("没有可导出的笔画".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("选择笔画导出文件夹")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });

    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("文件夹选择线程异常：{e}"))?
        .map_err(|e| format!("文件夹选择异常：{e}"))?;
    let Some(dir) = picked else {
        return Ok(None);
    };
    let dir = dir.into_path().map_err(|e| format!("路径无效：{e}"))?;
    Ok(Some(write_svgs(&dir, files)?))
}

/// 直接写入已记住的导出目录，不再弹文件夹选择框。
#[tauri::command]
pub async fn save_svgs_to(files: Vec<OutFile>, folder: String) -> Result<BatchResult, String> {
    let dir = std::path::PathBuf::from(&folder);
    write_svgs(&dir, files)
}

/// 把一个笔画的 SVG 写入目录；文件名净化、保留名处理和冲突后缀都在这里。
fn write_svgs(dir: &std::path::Path, files: Vec<OutFile>) -> Result<BatchResult, String> {
    if files.is_empty() {
        return Err("没有可导出的笔画".into());
    }
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建目录 {}：{e}", dir.display()))?;
    } else if !dir.is_dir() {
        return Err(format!("导出路径不是文件夹：{}", dir.display()));
    }

    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut names: Vec<String> = Vec::new();
    for f in files {
        let base = sanitize_name(&f.name);
        let mut file_name = format!("{base}.svg");
        let mut i = 2;
        // 同时避开本次批次的重复名和目录中已有的文件，避免静默覆盖
        while used.contains(&file_name.to_lowercase()) || dir.join(&file_name).exists() {
            file_name = format!("{base}-{i}.svg");
            i += 1;
        }
        used.insert(file_name.to_lowercase());

        let path = dir.join(&file_name);
        std::fs::write(&path, f.content.as_bytes())
            .map_err(|e| format!("写入失败 {}：{e}", path.display()))?;
        names.push(file_name);
    }

    Ok(BatchResult {
        folder: dir.to_string_lossy().to_string(),
        count: names.len(),
        names,
    })
}

/// 文件名净化：去掉 Windows 非法字符，空名回退为 stroke，并避开保留设备名。
fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let base = if trimmed.is_empty() { "stroke" } else { trimmed };
    // Windows 单个文件名上限 255 个 UTF-16 单元，留足余量并去掉尾部点/空格
    let mut out: String = base.chars().take(80).collect();
    out = out.trim_end_matches(|c| c == ' ' || c == '.').to_string();
    if out.is_empty() {
        return "stroke".to_string();
    }
    if is_reserved_name(&out) {
        out.push_str("-stroke");
    }
    out
}

/// Windows 保留设备名（CON / PRN / AUX / NUL / COM1-9 / LPT1-9，带扩展名也算）。
fn is_reserved_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = stem.as_bytes();
    if bytes.len() == 4 {
        if let Some(prefix) = stem.get(..3) {
            if (prefix == "COM" || prefix == "LPT") && bytes[3].is_ascii_digit() && bytes[3] != b'0' {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{name}-{}", std::process::id()))
    }

    #[test]
    fn writes_svg_file() {
        let dir = test_dir("svg");
        let p = dir.join("nested/out.svg");
        let _ = std::fs::remove_dir_all(&dir);
        write_svg(&p, "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").expect("write failed");
        let s = std::fs::read_to_string(&p).expect("read failed");
        assert!(s.starts_with("<svg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_name("竖钩"), "竖钩");
        assert_eq!(sanitize_name("a/b:c*?"), "a_b_c__");
        assert_eq!(sanitize_name("   "), "stroke");
        assert_eq!(sanitize_name("..."), "stroke");
        assert_eq!(sanitize_name(" 点 "), "点");
    }

    #[test]
    fn sanitizes_windows_reserved_names() {
        assert_eq!(sanitize_name("CON"), "CON-stroke");
        assert_eq!(sanitize_name("com1.svg"), "com1.svg-stroke");
        assert_eq!(sanitize_name("Aux.txt"), "Aux.txt-stroke");
        assert_eq!(sanitize_name("COM0"), "COM0");
        assert_eq!(sanitize_name("console"), "console");
    }

    #[test]
    fn truncates_long_file_names() {
        let long = "笔".repeat(200);
        let out = sanitize_name(&long);
        assert_eq!(out.chars().count(), 80);
    }

    #[test]
    fn writes_batch_and_avoids_existing_names() {
        let dir = test_dir("batch");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("同名.svg"), "old").unwrap();

        let files = vec![
            OutFile { name: "同名".into(), content: "<svg>1</svg>".into() },
            OutFile { name: "同名".into(), content: "<svg>2</svg>".into() },
        ];
        let res = write_svgs(&dir, files).expect("batch write failed");
        assert_eq!(res.count, 2);
        assert_eq!(res.names, vec!["同名-2.svg", "同名-3.svg"]);
        assert!(dir.join("同名-2.svg").exists());
        assert!(dir.join("同名-3.svg").exists());

        // 直接写入指定目录（模拟记住目录后的第二次导出）
        let files = vec![OutFile { name: "新笔画".into(), content: "<svg>3</svg>".into() }];
        let res = write_svgs(&dir, files).expect("direct batch write failed");
        assert_eq!(res.count, 1);
        assert_eq!(res.folder, dir.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
