// AI Module - Rust Backend for AI/LLM Operations
//
// This module provides the backend infrastructure for AI/LLM integration,
// including provider abstractions and inference handling.

use serde::{Deserialize, Serialize};

/// Supported AI model providers
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModelProvider {
    TransformerJS,
    Ollama,
    #[serde(rename = "openai-compatible")]
    OpenAICompatible,
    LlamaCpp,
    MLX,
}

/// AI operation modes. Agent is the only mode — kept as a single-variant
/// enum so deserialization of `mode: "agent"` from the frontend keeps working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AIMode {
    Agent,
}

/// Message role in a conversation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

/// Model configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: ModelProvider,
    pub model_id: String,
    pub parameters: ModelParameters,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub is_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub recommended_for: Vec<AIMode>,
}

/// Model inference parameters
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelParameters {
    pub temperature: f32,
    pub top_p: f32,
    pub max_tokens: u32,
    pub stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
}

/// Chat message
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub timestamp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_streaming: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Tool calls in OpenAI format (for native function calling)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<OpenAIToolCall>>,
    /// Base64-encoded JPEG screenshots attached to this message (browser-use
    /// vision payload). Vision-capable models receive these as
    /// content[].image_url blocks; non-vision providers drop them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    /// For Tool role messages: the tool_call_id this result corresponds to.
    /// Must match the id of the preceding assistant message's tool_call entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Inference request
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceRequest {
    pub session_id: String,
    pub model_config: ModelConfig,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fs_context: Option<FileSystemContext>,
    pub mode: AIMode,
    /// Optional tools for native function calling (OpenAI format)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Tool>>,
}

/// File system context
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemContext {
    pub current_path: String,
    pub selected_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_files: Option<Vec<FileMetadata>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_data: Option<ScanSummary>,
}

/// File metadata for context
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u64>,
    pub last_modified: i64,
}

/// Scan summary
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub total_files: u64,
    pub total_size: u64,
    pub largest_files: Vec<FileInfo>,
    pub file_types: std::collections::HashMap<String, u64>,
    pub scanned_at: i64,
}

/// File information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size: u64,
}

/// OpenAI-compatible tool definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub r#type: String, // "function"
    pub function: ToolFunction,
}

/// Tool function definition
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema object
}

/// Tool call in response (OpenAI format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIToolCall {
    pub id: String,
    pub r#type: String, // "function"
    pub function: OpenAIToolCallFunction,
}

/// Tool call function data (OpenAI format)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIToolCallFunction {
    pub name: String,
    pub arguments: String, // JSON string of arguments
}

/// Inference response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferenceResponse {
    pub message: ChatMessage,
    pub is_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_time_ms: Option<u64>,
}

/// Token usage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Provider status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ModelProvider,
    pub is_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub available_models: Vec<ModelConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// AI error types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AIErrorType {
    ModelNotFound,
    ProviderUnavailable,
    InferenceFailed,
    OutOfMemory,
    NetworkError,
    InvalidConfiguration,
    ContextTooLarge,
}

/// AI error
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIError {
    pub error_type: AIErrorType,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_actions: Option<Vec<String>>,
}

impl std::fmt::Display for AIError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", format!("{:?}", self.error_type), self.message)
    }
}

impl std::error::Error for AIError {}

pub mod providers;
