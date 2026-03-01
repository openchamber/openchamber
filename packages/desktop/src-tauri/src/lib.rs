#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_runtime;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn run() {
    desktop_runtime::run();
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let log_builder = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .clear_targets()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ]);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_haptics::init())
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(log_builder.build())
        .setup(|app| {
            let label = "main";
            if app.get_webview_window(label).is_some() {
                return Ok(());
            }

            let webview_url = if cfg!(debug_assertions) {
                let parse_bool_env = |name: &str| {
                    std::env::var(name)
                        .ok()
                        .map(|value| {
                            matches!(
                                value.trim().to_ascii_lowercase().as_str(),
                                "1" | "true" | "yes" | "on"
                            )
                        })
                        .unwrap_or(false)
                };

                let force_bundled_ui = parse_bool_env("OPENCHAMBER_MOBILE_FORCE_BUNDLED_UI");
                let force_dev_url = parse_bool_env("OPENCHAMBER_MOBILE_FORCE_DEV_URL");

                let host = std::env::var("TAURI_DEV_HOST")
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "localhost".to_string());
                let host = if cfg!(target_os = "ios") && host == "127.0.0.1" {
                    "localhost".to_string()
                } else {
                    host
                };
                let port = std::env::var("TAURI_DEV_PORT")
                    .ok()
                    .and_then(|value| value.trim().parse::<u16>().ok())
                    .unwrap_or(5173);
                let url = format!("http://{host}:{port}");

                if force_bundled_ui {
                    WebviewUrl::App("index.html".into())
                } else {
                match url::Url::parse(&url) {
                    Ok(parsed) => {
                        if force_dev_url {
                            WebviewUrl::External(parsed)
                        } else {
                            let reachable = parsed
                                .host_str()
                                .zip(parsed.port_or_known_default())
                                .map(|(target_host, target_port)| {
                                    let timeout = Duration::from_millis(450);
                                    (target_host, target_port)
                                        .to_socket_addrs()
                                        .ok()
                                        .map(|addresses| {
                                            addresses.into_iter().any(|address| {
                                                TcpStream::connect_timeout(&address, timeout).is_ok()
                                            })
                                        })
                                        .unwrap_or(false)
                                })
                                .unwrap_or(false);

                            if reachable {
                                WebviewUrl::External(parsed)
                            } else {
                                log::warn!(
                                    "mobile dev server {} is unreachable, falling back to bundled frontend",
                                    url
                                );
                                WebviewUrl::App("index.html".into())
                            }
                        }
                    }
                    Err(_) => WebviewUrl::App("index.html".into()),
                }
                }
            } else {
                WebviewUrl::App("index.html".into())
            };

            WebviewWindowBuilder::new(app, label, webview_url)
                .build()?;

            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build mobile Tauri application");

    app.run(|_, _| {});
}
