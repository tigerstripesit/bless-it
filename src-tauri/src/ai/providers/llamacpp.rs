use crate::ai::{
    AIError, AIErrorType, ChatMessage, InferenceRequest, InferenceResponse, MessageRole,
    ModelConfig, ModelParameters, ModelProvider, ProviderStatus, TokenUsage, AIMode
};
use futures_util::StreamExt;
use lazy_static::lazy_static;
use reqwest::Client;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::Mutex as TokioMutex;
use std::time::Duration;

const DEFAULT_PORT: u16 = 8081;
const LLAMA_SERVER_BIN: &str = "llama-server";

lazy_static! {
    static ref LLAMACPP_STATE: Arc<TokioMutex<LlamaCppState>> = Arc::new(TokioMutex::new(LlamaCppState::default()));
}

struct LlamaCppState {
    process: Option<Child>,
    port: u16,
    is_running: bool,
    model_loaded: Option<String>,
}

impl Default for LlamaCppState {
    fn default() -> Self {
        Self { process: None, port: DEFAULT_PORT, is_running: false, model_loaded: None }
    }
}

// --- Model Registry ---

pub struct GGUFModel {
    pub repo: &'static str,
    pub model_file: &'static str,
    pub mmproj_file: Option<&'static str>,
    pub display_name: &'static str,
    pub size_bytes: u64,
    pub context_length: u32,
    pub min_ram_gb: u32,
    pub recommended_ram_gb: u32,
}

fn get_model_registry() -> &'static [GGUFModel] {
    &[
        GGUFModel {
            repo: "ggml-org/Qwen2.5-Coder-0.5B-Q8_0-GGUF",
            model_file: "qwen2.5-coder-0.5b-q8_0.gguf",
            mmproj_file: None,
            display_name: "Qwen 2.5 Coder 0.5B (Q8_0)",
            size_bytes: 495_000_000,
            context_length: 8192,
            min_ram_gb: 2,
            recommended_ram_gb: 4,
        },
        GGUFModel {
            repo: "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF",
            model_file: "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
            mmproj_file: Some("mmproj-Qwen2.5-VL-3B-Instruct-f16.gguf"),
            display_name: "Qwen 2.5 VL 3B (Q4_K_M)",
            size_bytes: 1_930_000_000,
            context_length: 8192,
            min_ram_gb: 6,
            recommended_ram_gb: 8,
        },
        GGUFModel {
            // bartowski provides single-file Q4_K_M GGUFs — no split parts to
            // deal with. The 7B Instruct model is the sweet spot for agentic
            // tool use: strong instruction following, fits in 8 GB VRAM/RAM.
            repo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
            model_file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
            mmproj_file: None,
            display_name: "Qwen 2.5 7B Instruct (Q4_K_M)",
            size_bytes: 4_680_000_000,
            context_length: 32768,
            min_ram_gb: 8,
            recommended_ram_gb: 12,
        },
    ]
}

pub fn get_system_ram_gb() -> u32 {
    let mut info = System::new_all();
    info.refresh_memory();
    (info.total_memory() / (1024 * 1024 * 1024)) as u32
}

pub fn recommend_model_for_system() -> &'static GGUFModel {
    let ram_gb = get_system_ram_gb();
    get_model_registry().iter()
        .filter(|m| ram_gb >= m.min_ram_gb)
        .max_by_key(|m| m.size_bytes)
        .unwrap_or_else(|| &get_model_registry()[0])
}

fn get_default_model() -> &'static GGUFModel {
    recommend_model_for_system()
}

pub fn find_model_by_file(model_file: &str) -> Option<&'static GGUFModel> {
    get_model_registry().iter().find(|m| m.model_file == model_file)
}

pub fn find_model_by_name(name: &str) -> Option<&'static GGUFModel> {
    get_model_registry().iter().find(|m| m.display_name.contains(name) || m.model_file.contains(name))
}

pub fn get_model_registry_safe() -> &'static [GGUFModel] {
    get_model_registry()
}

pub fn get_models_dir_public() -> PathBuf {
    get_models_dir()
}

// --- Paths ---

fn get_models_dir() -> PathBuf {
    dirs::data_dir()
        .map(|p| p.join("ittoolkit").join("models"))
        .unwrap_or_else(|| PathBuf::from("models"))
}

fn get_llama_server_path() -> PathBuf {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("llama-server");
    if dev_path.exists() {
        return dev_path;
    }
    PathBuf::from("llama-server")
}

// --- Download ---

#[derive(Clone, serde::Serialize)]
pub struct DownloadStatus {
    pub status: String,
    pub progress: f32,
}

pub async fn download_gguf_model(model: &GGUFModel, sender: Option<tokio::sync::mpsc::Sender<DownloadStatus>>) -> Result<(PathBuf, Option<PathBuf>), AIError> {
    let models_dir = get_models_dir();
    std::fs::create_dir_all(&models_dir).map_err(|e| AIError {
        error_type: AIErrorType::InvalidConfiguration,
        message: format!("Failed to create models dir: {}", e),
        details: None, suggested_actions: None,
    })?;

    let report = |msg: &str, prog: f32| {
        if let Some(ref tx) = sender {
            let _ = tx.try_send(DownloadStatus { status: msg.to_string(), progress: prog });
        }
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(3600))
        .build()
        .map_err(|e| AIError {
            error_type: AIErrorType::NetworkError,
            message: format!("Failed to create HTTP client: {}", e),
            details: None, suggested_actions: None,
        })?;

    let download_file = async |filename: &str, progress_start: f32, progress_end: f32| -> Result<PathBuf, AIError> {
        let path = models_dir.join(filename);
        if path.exists() {
            report(&format!("{} already downloaded", filename), progress_end);
            return Ok(path);
        }

        let url = format!("https://huggingface.co/{}/resolve/main/{}", model.repo, filename);
        report(&format!("Downloading {}...", filename), progress_start);

        let response = client.get(&url).send().await.map_err(|e| AIError {
            error_type: AIErrorType::NetworkError,
            message: format!("Download failed for {}: {}", filename, e),
            details: None, suggested_actions: Some(vec!["Check internet connection".to_string()]),
        })?;

        let total_size = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut bytes = Vec::new();
        let mut last_reported: i32 = -1;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AIError {
                error_type: AIErrorType::NetworkError,
                message: format!("Download failed for {}: {}", filename, e),
                details: None, suggested_actions: None,
            })?;
            downloaded += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
            if total_size > 0 {
                let pct = progress_start + (progress_end - progress_start) * (downloaded as f32 / total_size as f32);
                let rounded = (pct * 100.0) as i32;
                if rounded != last_reported {
                    last_reported = rounded;
                    report(&format!("Downloading {}...", filename), pct);
                }
            }
        }

        std::fs::write(&path, &bytes).map_err(|e| AIError {
            error_type: AIErrorType::InferenceFailed,
            message: format!("Failed to save {}: {}", filename, e),
            details: None, suggested_actions: None,
        })?;

        report(&format!("Downloaded {}", filename), progress_end);
        Ok(path)
    };

    let model_path = download_file(model.model_file, 0.1, 0.7).await?;
    let mmproj_path = if let Some(mmproj) = model.mmproj_file {
        Some(download_file(mmproj, 0.7, 1.0).await?)
    } else {
        None
    };

    report("Ready", 1.0);
    Ok((model_path, mmproj_path))
}

// --- Server Lifecycle ---

async fn ensure_server_running(model_id: &str) -> Result<u16, AIError> {
    let mut state = LLAMACPP_STATE.lock().await;

    if state.is_running && state.model_loaded.as_deref() == Some(model_id) {
        return Ok(state.port);
    }

    if state.is_running {
        if let Some(ref mut proc) = state.process {
            let _ = proc.kill().ok();
            let _ = proc.wait().ok();
        }
        state.is_running = false;
        state.model_loaded = None;
    }

    let registry = get_model_registry();
    let model = registry.iter().find(|m| m.model_file == model_id || m.display_name.contains(model_id))
        .unwrap_or_else(|| get_default_model());

    let models_dir = get_models_dir();
    let model_path = models_dir.join(model.model_file);
    if !model_path.exists() {
        println!("[LlamaCpp] Model not found, downloading: {}", model.model_file);
        download_gguf_model(model, None).await?;
    }

    let binary_path = get_llama_server_path();
    if !binary_path.exists() {
        return Err(AIError {
            error_type: AIErrorType::ProviderUnavailable,
            message: "llama-server binary not found".to_string(),
            details: None,
            suggested_actions: Some(vec![
                "Download llama-server from https://github.com/ggml-org/llama.cpp/releases".to_string(),
            ]),
        });
    }

    let port = DEFAULT_PORT;
    let mut cmd = Command::new(&binary_path);

    cmd.arg("--host").arg("127.0.0.1")
        .arg("--port").arg(port.to_string())
        .arg("-m").arg(&model_path)
        .arg("--ctx-size").arg(model.context_length.to_string())
        .arg("--threads").arg(num_cpus::get().to_string())
        .arg("--flash-attn").arg("on");

    if let Some(mmproj) = &model.mmproj_file {
        let mmproj_path = models_dir.join(mmproj);
        if mmproj_path.exists() {
            cmd.arg("--mmproj").arg(&mmproj_path);
        }
    }

    #[cfg(target_os = "macos")]
    cmd.args(["-ngl", "99"]);

    let process = cmd.spawn().map_err(|e| AIError {
        error_type: AIErrorType::ProviderUnavailable,
        message: format!("Failed to start llama-server: {}", e),
        details: None,
        suggested_actions: Some(vec!["Check that llama-server is installed and executable".to_string()]),
    })?;

    state.process = Some(process);
    state.port = port;
    state.model_loaded = Some(model_id.to_string());

    let client = Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();

    let health_url = format!("http://127.0.0.1:{}/health", port);
    for i in 0..30 {
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                state.is_running = true;
                println!("[LlamaCpp] Server ready on port {} (attempt {})", port, i + 1);
                return Ok(port);
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    return Err(AIError {
        error_type: AIErrorType::ProviderUnavailable,
        message: "llama-server failed to start within 30 seconds".to_string(),
        details: None, suggested_actions: None,
    });
}

// --- Public API ---

pub async fn check_llamacpp_availability() -> bool {
    let binary_path = get_llama_server_path();
    binary_path.exists()
}

pub async fn get_llamacpp_status() -> ProviderStatus {
    let available = check_llamacpp_availability().await;
    let state = LLAMACPP_STATE.lock().await;

    let models: Vec<ModelConfig> = if available {
        get_model_registry().iter().map(|m| {
            let models_dir = get_models_dir();
            let is_downloaded = models_dir.join(m.model_file).exists();
            ModelConfig {
                id: format!("llamacpp-{}", m.model_file),
                name: m.display_name.to_string(),
                provider: ModelProvider::LlamaCpp,
                model_id: m.model_file.to_string(),
                parameters: ModelParameters {
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2048,
                    stream: true,
                    stop_sequences: None,
                    context_window: Some(m.context_length),
                },
                endpoint: Some(format!("http://127.0.0.1:{}", state.port)),
                api_key: None,
                is_available: is_downloaded,
                size_bytes: Some(m.size_bytes),
                recommended_for: vec![AIMode::Agent],
            }
        }).collect()
    } else {
        vec![]
    };

    ProviderStatus {
        provider: ModelProvider::LlamaCpp,
        is_available: available,
        version: None,
        available_models: models,
        error: if available { None } else { Some("llama-server binary not found. Download from https://github.com/ggml-org/llama.cpp/releases".to_string()) },
    }
}

pub async fn run_llamacpp_inference(request: &InferenceRequest) -> Result<InferenceResponse, AIError> {
    let model_id = &request.model_config.model_id;
    let port = ensure_server_running(model_id).await?;

    let client = Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| AIError {
            error_type: AIErrorType::InferenceFailed,
            message: format!("Failed to create HTTP client: {}", e),
            details: None, suggested_actions: None,
        })?;

    // Build OpenAI-compatible messages array
    let mut openai_messages = Vec::new();
    for msg in &request.messages {
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::System => "system",
            // LlamaCpp uses XML-based tool calling; native tool results don't
            // arise here, but fall back to "user" defensively.
            MessageRole::Tool => "user",
        };
        openai_messages.push(serde_json::json!({
            "role": role,
            "content": msg.content,
        }));
    }

    // Stop tokens for Qwen / ChatML models.
    // The im_end and im_start tokens mark turn boundaries in ChatML format.
    // Without them a 0.5B model frequently overshoots EOS and enters the
    // degenerate "loaf = loaf = ..." repetition loop. We build the token
    // strings at runtime to avoid angle-bracket literals in source.
    let im_end   = format!("{}im_end{}", '<', '>').replace('<', "<|").replace('>', "|>");
    let im_start = format!("{}im_start{}", '<', '>').replace('<', "<|").replace('>', "|>");
    let eos_tok  = "</s>".to_string();
    let stop_tokens: Vec<String> = request.model_config.parameters.stop_sequences
        .clone()
        .unwrap_or_else(|| vec![im_end, im_start, eos_tok]);

    let mut body = serde_json::json!({
        "model": model_id,
        "messages": openai_messages,
        "temperature": request.model_config.parameters.temperature,
        "top_p": request.model_config.parameters.top_p,
        "max_tokens": request.model_config.parameters.max_tokens,
        "stream": false,
        // repeat_penalty penalises tokens that have appeared recently.
        // A value of 1.15 matches llama.cpp defaults that prevent runaway
        // repetition without degrading response quality on small models.
        "repeat_penalty": 1.15,
        // repeat_last_n: how many tokens of history to search for repeats.
        "repeat_last_n": 64,
        // min_p filters unlikely tokens; combined with repeat_penalty this
        // further reduces the chance of the model looping on one token.
        "min_p": 0.05,
        "stop": stop_tokens,
    });

    // Add tools for native function calling if provided
    if let Some(tools) = &request.tools {
        body["tools"] = serde_json::to_value(tools).unwrap_or_default();
    }

    let url = format!("http://127.0.0.1:{}/v1/chat/completions", port);
    let start_time = std::time::Instant::now();

    let resp = client.post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AIError {
            error_type: AIErrorType::InferenceFailed,
            message: format!("Inference request failed: {}", e),
            details: None, suggested_actions: None,
        })?;

    let data: serde_json::Value = resp.json().await.map_err(|e| AIError {
        error_type: AIErrorType::InferenceFailed,
        message: format!("Failed to parse response: {}", e),
        details: None, suggested_actions: None,
    })?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // Parse tool_calls from response if present
    let tool_calls = data["choices"][0]["message"]["tool_calls"]
        .as_array()
        .map(|arr| {
            arr.iter().filter_map(|tc| {
                Some(crate::ai::OpenAIToolCall {
                    id: tc["id"].as_str()?.to_string(),
                    r#type: "function".to_string(),
                    function: crate::ai::OpenAIToolCallFunction {
                        name: tc["function"]["name"].as_str()?.to_string(),
                        arguments: tc["function"]["arguments"].as_str()?.to_string(),
                    },
                })
            }).collect::<Vec<_>>()
        })
        .filter(|v: &Vec<_>| !v.is_empty());

    let usage = data["usage"].as_object().map(|u| TokenUsage {
        prompt_tokens: u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        completion_tokens: u.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        total_tokens: u.get("total_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    });

    Ok(InferenceResponse {
        message: ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content,
            timestamp: chrono::Utc::now().timestamp_millis(),
            context_paths: None,
            is_streaming: Some(false),
            error: None,
            tool_calls,
            images: None,
            tool_call_id: None,
        },
        is_complete: true,
        usage,
        inference_time_ms: Some(start_time.elapsed().as_millis() as u64),
    })
}
