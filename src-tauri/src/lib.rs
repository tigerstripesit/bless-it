mod scanner;
mod commands;
mod ai;
mod ai_commands;
mod cleaner;
mod execute_command;
mod shell_classify;
mod system_tools;
mod partition;
mod partition_commands;
mod conversations;
mod skills;
mod user_info;
mod user_profile;
mod audit_log;
mod browser_capability;
mod browser_classify;
mod browser_commands;
mod workflow_recorder;
mod workflow_db;
mod web_search;

use std::str::FromStr;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      if let Err(e) = skills::seed_default_skills(&app.handle()) {
        log::warn!("Failed to seed default skills: {}", e);
      }
      if let Err(e) = workflow_recorder::seed_default_workflows(&app.handle()) {
        log::warn!("Failed to seed default workflows: {}", e);
      }
      // Initialize SQLite-backed workflow run state
      match workflow_db::WorkflowDb::new() {
        Ok(db) => {
          app.handle().manage(db);
          log::info!("Initialized workflow SQLite database");
        }
        Err(e) => log::error!("Failed to initialize workflow database: {}", e),
      }

      // Start background scheduler — checks due workflows every 60 seconds
      let handle = app.handle().clone();
      tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        interval.tick().await; // skip first immediate tick

        loop {
          interval.tick().await;

          let db = match handle.try_state::<workflow_db::WorkflowDb>() {
            Some(d) => d,
            None => {
              log::warn!("[scheduler] WorkflowDb not available yet");
              continue;
            }
          };

          let schedules = match db.due_schedules() {
            Ok(s) => s,
            Err(e) => {
              log::error!("[scheduler] failed to query due schedules: {}", e);
              continue;
            }
          };

          for sched in schedules {
            log::info!("[scheduler] running workflow '{}' (cron: {})", sched.workflow_slug, sched.cron_expression);

            // Validate workflow file
            let wf_path = match workflow_recorder::workflows_dir() {
              Ok(dir) => dir.join(format!("{}.workflow.json", &sched.workflow_slug)),
              Err(e) => {
                log::error!("[scheduler] cannot resolve workflows dir: {}", e);
                continue;
              }
            };

            if !wf_path.exists() {
              log::warn!("[scheduler] workflow '{}' not found at {}", sched.workflow_slug, wf_path.display());
              continue;
            }

            // Count steps
            let step_count = match tokio::fs::read_to_string(&wf_path).await {
              Ok(content) => serde_json::from_str::<serde_json::Value>(&content)
                .ok()
                .and_then(|v| v.get("steps")?.as_array().map(|a| a.len()))
                .unwrap_or(0),
              Err(e) => {
                log::error!("[scheduler] failed to read workflow '{}': {}", sched.workflow_slug, e);
                continue;
              }
            };

            match db.create_run(&sched.workflow_slug, &sched.variables, step_count, None) {
              Ok(run) => {
                log::info!("[scheduler] created run {} for '{}'", run.run_id, sched.workflow_slug);

                // Compute next occurrence from cron expression
                let next = cron::Schedule::from_str(&sched.cron_expression)
                  .ok()
                  .and_then(|parsed| {
                    parsed.upcoming(chrono::Utc).next()
                  })
                  .map(|t| t.to_rfc3339());

                match next {
                  Some(ref next_str) if !next_str.is_empty() => {
                    db.mark_schedule_run(sched.id, next_str).ok();
                  }
                  _ => {
                    log::warn!("[scheduler] cron '{}' has no future occurrences, disabling", sched.cron_expression);
                    db.toggle_schedule(&sched.workflow_slug, false).ok();
                    db.mark_schedule_run(sched.id, "").ok();
                  }
                }
              }
              Err(e) => {
                log::error!("[scheduler] failed to create run for '{}': {}", sched.workflow_slug, e);
              }
            }
          }
        }
      });

      Ok(())
    })
    .manage(ai_commands::InferenceState::default())
    .manage(browser_commands::BrowserSupervisor::default())
    .manage(workflow_recorder::WorkflowRecorder::default())
    .manage(browser_capability::BrowserCapabilityState::default())
    .invoke_handler(tauri::generate_handler![
        commands::scan_dir,
        commands::refresh_scan,
        commands::clear_cache,
        commands::reveal_in_explorer,
        commands::open_file,
        commands::delete_item,
        commands::get_drives,
        commands::cancel_scan,
        ai_commands::get_ai_providers_status,
        ai_commands::get_provider_models,
        ai_commands::run_ai_inference,
        ai_commands::cancel_inference,
        ai_commands::check_provider_availability,
        ai_commands::download_llamacpp_model,
        ai_commands::get_llamacpp_recommendation,
        commands::scan_junk,
        commands::scan_junk_with_options,
        commands::clean_junk,
        commands::clean_junk_with_options,
        execute_command::execute_command,
        // System Tools
        system_tools::get_disk_info,
        system_tools::get_network_interfaces,
        system_tools::ping_host,
        system_tools::dns_lookup,
        system_tools::scan_ports,
        system_tools::get_system_info,
        system_tools::get_services,
        system_tools::service_action,
        system_tools::get_process_list,
        system_tools::kill_process,
        system_tools::get_security_logs,
        system_tools::get_open_ports,
        // Partition Management
        partition_commands::get_disks,
        partition_commands::get_partitions,
        partition_commands::get_partition_info,
        partition_commands::validate_expand_partition,
        partition_commands::validate_shrink_partition,
        partition_commands::expand_partition,
        partition_commands::shrink_partition,
        partition_commands::create_space_reallocation_plan,
        partition_commands::unmount_partition,
        partition_commands::mount_partition,
        partition_commands::validate_delete_partition,
        partition_commands::delete_partition,
        partition_commands::execute_partition_moves,
        // Conversations
        conversations::list_conversations,
        conversations::load_conversation,
        conversations::create_conversation,
        conversations::append_message,
        conversations::update_conversation_title,
        conversations::delete_conversation,
        conversations::update_conversation_summary,
        conversations::search_conversations_content,
        // User profile (durable cross-conversation memory)
        user_profile::load_user_profile,
        user_profile::save_user_profile,
        user_profile::merge_user_profile_facts,
        // Skills
        skills::list_skills,
        skills::get_skill_source,
        skills::load_skill_body,
        skills::get_site_skill_body,
        skills::set_skill_enabled,
        skills::set_skill_trusted,
        skills::open_skills_folder,
        // Web search (DuckDuckGo, no API key)
        web_search::web_search_ddg,
        // User info
        user_info::get_user_name,
        // Audit log for destructive agent actions
        audit_log::log_action_event,
        audit_log::log_browser_action_event,
        // Browser-use harness (M1: read-only RPC to Playwright sidecar)
        browser_commands::browser_rpc,
        browser_commands::browser_shutdown,
        // Workflow capability
        workflow_recorder::workflow_recording_start,
        workflow_recorder::workflow_recording_stop,
        workflow_recorder::workflow_recording_status,
        workflow_recorder::workflow_recording_finalize,
        workflow_recorder::get_workflow_schema,
        workflow_recorder::workflow_list,
        workflow_recorder::workflow_load,
        workflow_recorder::workflow_delete,
        workflow_recorder::workflow_update,
        workflow_recorder::workflow_replay_bind,
        // Workflow run checkpoints (durable execution state)
        workflow_recorder::workflow_run_create,
        workflow_recorder::workflow_run_checkpoint,
        workflow_recorder::workflow_run_pause_for_gate,
        workflow_recorder::workflow_run_resolve_gate,
        workflow_recorder::workflow_run_complete,
        workflow_recorder::workflow_run_list_incomplete,
    workflow_recorder::workflow_trace_event_insert,
    workflow_recorder::workflow_trace_events_list,
    // Non-browser executors
    workflow_recorder::workflow_shell_exec,
    workflow_recorder::workflow_http_request,
    // Schedule management
    workflow_recorder::workflow_schedule_set,
    workflow_recorder::workflow_schedule_get,
    workflow_recorder::workflow_schedule_list,
    workflow_recorder::workflow_schedule_delete,
    workflow_recorder::workflow_schedule_toggle,
        // Browser capability gate (M5: per-skill URL allowlist)
        browser_capability::browser_set_capabilities,
        browser_capability::browser_clear_capabilities,
        browser_capability::browser_get_capabilities
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

