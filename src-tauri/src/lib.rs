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
      Ok(())
    })
    .manage(ai_commands::InferenceState::default())
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
        skills::set_skill_enabled,
        skills::set_skill_trusted,
        skills::open_skills_folder,
        // User info
        user_info::get_user_name
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

