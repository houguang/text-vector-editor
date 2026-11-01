//! GlyphCut — 文字转矢量线条编辑器（Tauri 2 后端入口）

mod fonts;
mod geom;
mod outline;
mod save;
mod store;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 系统字体插件：作为字体列表的兜底通道（前端调用失败时回退）
        .plugin(tauri_plugin_system_fonts::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            fonts::list_fonts,
            outline::measure_text,
            outline::outline_text,
            save::save_svg,
            save::choose_folder,
            save::save_svgs_dialog,
            save::save_svgs_to,
            store::list_projects,
            store::save_project,
            store::load_project,
            store::delete_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
