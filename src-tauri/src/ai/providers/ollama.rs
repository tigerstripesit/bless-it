// Ollama Provider
//
// Integration with Ollama for local LLM inference via HTTP API.

use crate::ai::{
    AIError, AIErrorType, AIMode, ChatMessage, InferenceRequest, InferenceResponse, MessageRole,
    ModelConfig, ModelParameters, ModelProvider, ProviderStatus, TokenUsage,
};
use reqwest;
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::Emitter;
use std::io::BufRead; 
use bytes::Buf;

/// Default Ollama endpoint
const DEFAULT_OLLAMA_ENDPOINT: &str = "http://127.0.0.1:11434";

/// Ollama chat request format
#[derive(Debug, Serialize)]
struct OllamaChatRequest {
    model: String,
    messages: Vec<OllamaMessage>,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Debug, Serialize, Deserialize)]
struct OllamaMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct OllamaOptions {
    temperature: f32,
    top_p: f32,
    num_predict: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

/// Ollama chat response format
#[derive(Debug, Deserialize)]
struct OllamaChatResponse {
    message: OllamaMessage,
    done: bool,
    #[serde(default)]
    total_duration: Option<u64>,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
}

/// Ollama list models response
#[derive(Debug, Deserialize)]
struct OllamaListResponse {
    models: Vec<OllamaModel>,
}

#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
    size: u64,
    modified_at: String,
}

/// Check if Ollama is available
pub async fn check_ollama_availability(endpoint: Option<&str>) -> Result<bool, AIError> {
    let url = format!("{}/api/tags", endpoint.unwrap_or(DEFAULT_OLLAMA_ENDPOINT));
    log::debug!("Checking Ollama status at: {}", url);

    match reqwest::get(&url).await {
        Ok(response) => {
            log::debug!("Ollama response status: {}", response.status());
            Ok(response.status().is_success())
        },
        Err(e) => {
            log::debug!("Ollama connection failed: {}", e);
            Ok(false)
        },
    }
}

/// Get available Ollama models
pub async fn get_ollama_models(endpoint: Option<&str>) -> Result<Vec<ModelConfig>, AIError> {
    let actual_endpoint = endpoint.unwrap_or(DEFAULT_OLLAMA_ENDPOINT);
    println!("[get_ollama_models] Using endpoint: {}", actual_endpoint);
    let url = format!("{}/api/tags", actual_endpoint);

    let response = reqwest::get(&url).await.map_err(|e| AIError {
        error_type: AIErrorType::NetworkError,
        message: format!("Failed to connect to Ollama: {}", e),
        details: None,
        suggested_actions: Some(vec![
            "Make sure Ollama is running".to_string(),
            "Check if Ollama is installed".to_string(),
            "Verify the endpoint URL".to_string(),
        ]),
    })?;

    let list: OllamaListResponse = response.json().await.map_err(|e| AIError {
        error_type: AIErrorType::ProviderUnavailable,
        message: format!("Failed to parse Ollama response: {}", e),
        details: None,
        suggested_actions: None,
    })?;

    let models: Vec<ModelConfig> = list
        .models
        .into_iter()
        .map(|m| {
            let recommended_for = vec![AIMode::Agent];

            ModelConfig {
                id: format!("ollama-{}", m.name.replace(':', "-")),
                name: m.name.clone(),
                provider: ModelProvider::Ollama,
                model_id: m.name,
                parameters: ModelParameters {
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2048,
                    stream: true,
                    stop_sequences: None,
                    context_window: Some(4096),
                },
                endpoint: Some(actual_endpoint.to_string()),
                api_key: None,
                is_available: true,
                size_bytes: Some(m.size),
                recommended_for,
            }
        })
        .collect();

    println!("[get_ollama_models] Returning {} models, all with endpoint: {}", models.len(), actual_endpoint);
    Ok(models)
}

/// Run inference with Ollama
pub async fn run_ollama_inference(
    window: tauri::Window,
    request: &InferenceRequest,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<InferenceResponse, AIError> {
    let start_time = Instant::now();

    let endpoint = request
        .model_config
        .endpoint
        .as_deref()
        .unwrap_or(DEFAULT_OLLAMA_ENDPOINT);

    let url = format!("{}/api/chat", endpoint);
    println!("[Ollama] Using endpoint: {}", endpoint);
    println!("[Ollama] Full URL: {}", url);
    println!("[Ollama] Model: {}", request.model_config.model_id);

    // Convert messages to Ollama format and inject context
    // ... (context injection logic remains same, just copied for brevity or assumed helper)
    // Actually I need to preserve the complex context injection logic.
    // I will copy the logic if I replace the whole function.
    // To minimize replacement size, I will reuse existing logic structure but change the request and response handling.
    
    // RE-IMPLEMENTING CONTEXT LOGIC (Truncated for tool call, I will perform surgically)
    let mut ollama_messages: Vec<OllamaMessage> = Vec::new();

    // 1. Inject Context if available (AND system message not already present)
    let has_system_message = request.messages.iter().any(|m| m.role == MessageRole::System);

    if !has_system_message {
        if let Some(ctx) = &request.fs_context {
        let mut context_str = String::new();
        context_str.push_str(&format!("Current Directory: {}\n", ctx.current_path));
        
        if !ctx.selected_paths.is_empty() {
             context_str.push_str("Selected Items:\n");
             for path in &ctx.selected_paths {
                 context_str.push_str(&format!("- {}\n", path));
             }
        }

        if let Some(visible) = &ctx.visible_files {
             if !visible.is_empty() {
                 context_str.push_str("\nVisible Files in Current Directory:\n");
                 // Limit to 50 for prompt context window safety
                 let take_count = std::cmp::min(visible.len(), 50);
                 for file in visible.iter().take(take_count) {
                      let size_str = if file.size >= 1024 * 1024 * 1024 {
                          format!("{:.2} GB", file.size as f64 / (1024.0 * 1024.0 * 1024.0))
                      } else if file.size >= 1024 * 1024 {
                          format!("{:.2} MB", file.size as f64 / (1024.0 * 1024.0))
                      } else if file.size >= 1024 {
                          format!("{:.2} KB", file.size as f64 / 1024.0)
                      } else {
                          format!("{} B", file.size)
                      };
                      
                      let type_str = if file.is_dir {
                          if let Some(count) = file.file_count {
                              format!("Folder, {} items", count)
                          } else {
                              "Folder".to_string()
                          }
                      } else {
                          format!("File, {}", size_str)
                      };
                      
                      context_str.push_str(&format!("- {} ({})\n", file.name, type_str));
                 }
                 if visible.len() > take_count {
                      context_str.push_str(&format!("...and {} more\n", visible.len() - take_count));
                 }
             }
        }
        
        if !context_str.is_empty() {
            ollama_messages.push(OllamaMessage {
                role: "system".to_string(),
                content: format!("Context Information:\n{}\nUse this context to answer the user's questions about their files.", context_str),
            });
        }
    }
    }

    // 2. Append Conversation History
    for m in &request.messages {
        ollama_messages.push(OllamaMessage {
            role: match m.role {
                MessageRole::User => "user".to_string(),
                MessageRole::Assistant => "assistant".to_string(),
                MessageRole::System => "system".to_string(),
                // Ollama uses XML-based tool calling; native tool results don't
                // arise here, but fall back to "user" defensively.
                MessageRole::Tool => "user".to_string(),
            },
            content: m.content.clone(),
        });
    }

    let ollama_request = OllamaChatRequest {
        model: request.model_config.model_id.clone(),
        messages: ollama_messages,
        stream: true,
        options: OllamaOptions {
            temperature: request.model_config.parameters.temperature,
            top_p: request.model_config.parameters.top_p,
            num_predict: request.model_config.parameters.max_tokens as i32,
            stop: request.model_config.parameters.stop_sequences.clone(),
        },
    };

    let client = reqwest::Client::new();
    println!("[Ollama] Sending request...");
    let response = client
        .post(&url)
        .json(&ollama_request)
        .send()
        .await
        .map_err(|e| AIError {
            error_type: AIErrorType::NetworkError,
            message: format!("Failed to send request to Ollama: {}", e),
            details: None,
            suggested_actions: Some(vec!["Check Ollama is running".to_string()]),
        })?;

    let status = response.status();
    println!("[Ollama] Response status: {}", status);

    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        println!("[Ollama] Error body: {}", error_body);
        return Err(AIError {
            error_type: AIErrorType::InferenceFailed,
            message: format!("Ollama returned error: {} - {}", status, error_body),
            details: None,
            suggested_actions: Some(vec![
                "Check if the model exists".to_string(),
                "Try pulling the model with 'ollama pull'".to_string(),
            ]),
        });
    }

    // Process streaming response
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt; // Ensure this feature is available or use loop
    
    let mut full_content = String::new();
    let mut final_usage: Option<TokenUsage> = None;
    let mut is_done = false;

    // We need to parse line by line, but bytes_stream returns chunks.
    // Simple approach: Accumulate bytes, split by newline, process lines.
    let mut buffer = Vec::new();

    while let Some(chunk_result) = stream.next().await {
        // Check if cancellation was requested
        if cancel_token.is_cancelled() {
            println!("[Ollama] Inference cancelled by user");
            return Err(AIError {
                error_type: AIErrorType::InferenceFailed,
                message: "Inference cancelled by user".to_string(),
                details: None,
                suggested_actions: None,
            });
        }

        let chunk = chunk_result.map_err(|e| AIError {
            error_type: AIErrorType::NetworkError,
            message: format!("Stream error: {}", e),
            details: None,
            suggested_actions: None,
        })?;

        buffer.extend_from_slice(&chunk);

        // Process full lines in buffer
        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = buffer.drain(..=pos).collect::<Vec<u8>>(); // Include newline
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            if line.is_empty() { continue; }

            if let Ok(ollama_msg) = serde_json::from_str::<OllamaChatResponse>(line) {
                let content = ollama_msg.message.content;
                if !content.is_empty() {
                    full_content.push_str(&content);
                    let _ = window.emit("ai-response-chunk", &content);
                }

                if ollama_msg.done {
                    is_done = true;
                    if let (Some(prompt_eval), Some(eval)) = (ollama_msg.prompt_eval_count, ollama_msg.eval_count) {
                        final_usage = Some(TokenUsage {
                            prompt_tokens: prompt_eval,
                            completion_tokens: eval,
                            total_tokens: prompt_eval + eval,
                        });
                    }
                }
            } else {
                eprintln!("Failed to parse JSON: {}", line);
            }
        }
    }

    let inference_time_ms = start_time.elapsed().as_millis() as u64;

    let response_message = ChatMessage {
        id: format!("msg-{}", chrono::Utc::now().timestamp_millis()),
        role: MessageRole::Assistant,
        content: full_content,
        timestamp: chrono::Utc::now().timestamp_millis(),
        context_paths: None,
        is_streaming: None,
        error: None,
        tool_calls: None,
        images: None,
        tool_call_id: None,
    };

    Ok(InferenceResponse {
        message: response_message,
        is_complete: is_done,
        usage: final_usage,
        inference_time_ms: Some(inference_time_ms),
    })
}

/// Get Ollama provider status
pub async fn get_ollama_status(endpoint: Option<&str>) -> ProviderStatus {
    let is_available = check_ollama_availability(endpoint).await.unwrap_or(false);

    let (available_models, error) = if is_available {
        match get_ollama_models(endpoint).await {
            Ok(models) => (models, None),
            Err(e) => (vec![], Some(e.message)),
        }
    } else {
        (
            vec![],
            Some("Ollama is not running or not installed".to_string()),
        )
    };

    ProviderStatus {
        provider: ModelProvider::Ollama,
        is_available,
        version: None, // Could be fetched from /api/version
        available_models,
        error,
    }
}
