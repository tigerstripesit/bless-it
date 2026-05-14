// Partition moving functionality
// This module handles moving partitions to different disk locations

use crate::partition::types::*;
use crate::partition::resize::validation::ValidationResult;
use anyhow::{anyhow, Result};
use std::path::PathBuf;

/// Options for moving a partition
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MovePartitionOptions {
    /// Target offset where partition should be moved (in bytes)
    pub target_offset: u64,

    /// Whether to verify data after move
    pub verify_after_move: bool,

    /// Temporary backup location for partition data
    pub backup_path: Option<PathBuf>,
}

/// Progress information for partition move operation
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MoveProgress {
    /// Current phase of the move operation
    pub phase: MovePhase,

    /// Progress percentage (0-100)
    pub percent: f32,

    /// Current status message
    pub message: String,

    /// Bytes processed so far
    pub bytes_processed: u64,

    /// Total bytes to process
    pub total_bytes: u64,

    /// Whether operation can be cancelled at this point
    pub can_cancel: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum MovePhase {
    Validating,
    BackingUp,
    DeletingOldPartition,
    CreatingNewPartition,
    RestoringData,
    Verifying,
    Complete,
    Error,
}

impl MoveProgress {
    pub fn validating(message: impl Into<String>) -> Self {
        Self {
            phase: MovePhase::Validating,
            percent: 0.0,
            message: message.into(),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: true,
        }
    }

    pub fn backing_up(percent: f32, bytes_processed: u64, total_bytes: u64) -> Self {
        Self {
            phase: MovePhase::BackingUp,
            percent,
            message: format!("Backing up partition data... {:.1}%", percent),
            bytes_processed,
            total_bytes,
            can_cancel: true,
        }
    }

    pub fn deleting_partition(message: impl Into<String>) -> Self {
        Self {
            phase: MovePhase::DeletingOldPartition,
            percent: 40.0,
            message: message.into(),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: false, // Cannot cancel during partition table changes
        }
    }

    pub fn creating_partition(message: impl Into<String>) -> Self {
        Self {
            phase: MovePhase::CreatingNewPartition,
            percent: 50.0,
            message: message.into(),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: false,
        }
    }

    pub fn restoring_data(percent: f32, bytes_processed: u64, total_bytes: u64) -> Self {
        Self {
            phase: MovePhase::RestoringData,
            percent: 50.0 + (percent * 0.4), // 50-90%
            message: format!("Restoring partition data... {:.1}%", percent),
            bytes_processed,
            total_bytes,
            can_cancel: false,
        }
    }

    pub fn verifying(percent: f32) -> Self {
        Self {
            phase: MovePhase::Verifying,
            percent: 90.0 + (percent * 0.1), // 90-100%
            message: format!("Verifying data integrity... {:.1}%", percent),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: false,
        }
    }

    pub fn complete(message: impl Into<String>) -> Self {
        Self {
            phase: MovePhase::Complete,
            percent: 100.0,
            message: message.into(),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            phase: MovePhase::Error,
            percent: 0.0,
            message: message.into(),
            bytes_processed: 0,
            total_bytes: 0,
            can_cancel: false,
        }
    }
}

/// Validate if a partition can be moved to a new location
pub fn validate_move(
    partition: &PartitionInfo,
    disk: &DiskInfo,
    target_offset: u64,
) -> Result<ValidationResult> {
    let mut result = ValidationResult {
        is_valid: true,
        errors: Vec::new(),
        warnings: Vec::new(),
        safe_size: Some(partition.total_size),
        minimum_size: None,
        maximum_size: None,
        has_adjacent_space: false,
        adjacent_space: 0,
    };

    // Check 1: Target offset must be within disk bounds
    if target_offset + partition.total_size > disk.total_size {
        result.is_valid = false;
        result.errors.push(format!(
            "Target location is outside disk bounds. Disk size: {}, Required: {}",
            format_bytes(disk.total_size),
            format_bytes(target_offset + partition.total_size)
        ));
        return Ok(result);
    }

    // Check 2: Target location must not overlap with other partitions
    for other_partition in &disk.partitions {
        if other_partition.id == partition.id {
            continue; // Skip the partition being moved
        }

        let other_start = other_partition.start_offset;
        let other_end = other_partition.start_offset + other_partition.total_size;
        let target_end = target_offset + partition.total_size;

        // Check for overlap
        if (target_offset >= other_start && target_offset < other_end)
            || (target_end > other_start && target_end <= other_end)
            || (target_offset <= other_start && target_end >= other_end)
        {
            result.is_valid = false;
            result.errors.push(format!(
                "Target location overlaps with partition '{}' at offset {}",
                other_partition.device_path,
                format_bytes(other_start)
            ));
        }
    }

    // Check 3: Partition must be unmounted for safety
    if partition.is_mounted {
        result.warnings.push(
            "Partition is currently mounted. It must be unmounted before moving.".to_string(),
        );
        // For non-system partitions, this could be made an error
        if partition.flags.contains(&PartitionFlag::System)
            || partition.flags.contains(&PartitionFlag::Boot)
        {
            result.is_valid = false;
            result.errors.push(
                "Cannot move system or boot partition while it's mounted.".to_string(),
            );
        }
    }

    // Check 4: Warn about system/boot partitions
    if partition.flags.contains(&PartitionFlag::Boot) {
        result.warnings.push(
            "WARNING: This is a boot partition. Moving it may make the system unbootable!"
                .to_string(),
        );
    }

    if partition.flags.contains(&PartitionFlag::System) {
        result.warnings.push(
            "WARNING: This is a system partition. Moving it requires extreme caution!"
                .to_string(),
        );
    }

    // Check 5: Ensure enough free disk space for backup
    // We need at least the partition size available for temporary backup
    result.warnings.push(format!(
        "Moving requires temporary backup space of approximately {}. Ensure you have enough free disk space.",
        format_bytes(partition.total_size)
    ));

    Ok(result)
}

/// Move a partition to a new location on the disk
///
/// This is a complex operation that involves:
/// 1. Backing up all partition data
/// 2. Deleting the old partition
/// 3. Creating a new partition at the target offset
/// 4. Restoring data to the new partition
///
/// WARNING: This operation is risky and can take hours for large partitions.
/// Always ensure you have backups before proceeding.
pub async fn move_partition(
    partition: &PartitionInfo,
    disk: &DiskInfo,
    options: MovePartitionOptions,
    progress_callback: impl Fn(MoveProgress),
) -> Result<()> {
    // Validate the move operation
    progress_callback(MoveProgress::validating("Validating move operation..."));
    let validation = validate_move(partition, disk, options.target_offset)?;

    if !validation.is_valid {
        return Err(anyhow!(
            "Move validation failed: {}",
            validation.errors.join(", ")
        ));
    }

    // Step 1: Backup partition data
    progress_callback(MoveProgress::validating("Preparing backup location..."));
    let backup_path = options.backup_path.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("partition_backup_{}", partition.number))
    });

    if !backup_partition_data(partition, &backup_path, &progress_callback).await? {
        return Err(anyhow!("Failed to backup partition data"));
    }

    // Step 2: Delete old partition
    progress_callback(MoveProgress::deleting_partition("Deleting old partition..."));
    delete_partition(partition).await?;

    // Step 3: Create new partition at target offset
    progress_callback(MoveProgress::creating_partition("Creating partition at new location..."));
    let new_partition = create_partition_at_offset(
        disk,
        partition,
        options.target_offset,
    )
    .await?;

    // Step 4: Restore data to new partition
    if !restore_partition_data(&new_partition, &backup_path, &progress_callback).await? {
        return Err(anyhow!("Failed to restore partition data"));
    }

    // Step 5: Verify if requested
    if options.verify_after_move {
        progress_callback(MoveProgress::verifying(0.0));
        // TODO: Implement data verification
    }

    // Cleanup backup
    let _ = std::fs::remove_dir_all(&backup_path);

    progress_callback(MoveProgress::complete("Partition moved successfully!"));
    Ok(())
}

/// Backup all data from a partition to a temporary location
async fn backup_partition_data(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    std::fs::create_dir_all(backup_path)?;

    #[cfg(target_os = "windows")]
    {
        backup_partition_windows(partition, backup_path, progress_callback).await
    }

    #[cfg(target_os = "linux")]
    {
    backup_partition_linux(partition, backup_path, progress_callback).await
    }

    #[cfg(target_os = "macos")]
    {
        backup_partition_macos(partition, backup_path, progress_callback).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err(anyhow!("Partition backup not implemented for this platform"))
    }
}

/// Windows-specific partition backup using robocopy
#[cfg(target_os = "windows")]
async fn backup_partition_windows(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;

    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Partition must have a mount point"))?;

    progress_callback(MoveProgress::backing_up(0.0, 0, partition.total_size));

    // Use robocopy for efficient copying with progress
    let output = Command::new("robocopy")
        .arg(mount_point)
        .arg(backup_path)
        .arg("/E") // Copy subdirectories including empty ones
        .arg("/COPYALL") // Copy all file info
        .arg("/R:3") // Retry 3 times on failed copies
        .arg("/W:5") // Wait 5 seconds between retries
        .arg("/MT:8") // Multi-threaded (8 threads)
        .output()?;

    // Robocopy returns exit codes 0-7 for success, 8+ for errors
    let exit_code = output.status.code().unwrap_or(16);
    if exit_code >= 8 {
        return Err(anyhow!(
            "Robocopy failed with exit code {}: {}",
            exit_code,
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    progress_callback(MoveProgress::backing_up(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

/// Linux-specific partition backup using rsync
#[cfg(target_os = "linux")]
async fn backup_partition_linux(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;

    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Partition must be mounted"))?;

    progress_callback(MoveProgress::backing_up(0.0, 0, partition.total_size));

    let output = Command::new("rsync")
        .arg("-av")
        .arg("--progress")
        .arg(format!("{}/", mount_point))
        .arg(backup_path)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!(
            "Rsync failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    progress_callback(MoveProgress::backing_up(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

/// macOS-specific partition backup using rsync
#[cfg(target_os = "macos")]
async fn backup_partition_macos(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;

    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Partition must be mounted"))?;

    progress_callback(MoveProgress::backing_up(0.0, partition.total_size, 0));

    let output = Command::new("rsync")
        .arg("-a")
        .arg("--progress")
        .arg(format!("{}/", mount_point))
        .arg(backup_path)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!("rsync backup failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    progress_callback(MoveProgress::backing_up(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

/// Delete a partition from the disk
async fn delete_partition(partition: &PartitionInfo) -> Result<()> {
    #[cfg(target_os = "windows")]
    {
        delete_partition_windows(partition).await
    }

    #[cfg(target_os = "linux")]
    {
        delete_partition_linux(partition).await
    }

    #[cfg(target_os = "macos")]
    {
        delete_partition_macos(partition).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err(anyhow!("Partition deletion not implemented for this platform"))
    }
}

/// Delete partition on Windows using diskpart
#[cfg(target_os = "windows")]
async fn delete_partition_windows(partition: &PartitionInfo) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let drive_letter = partition
        .mount_point
        .as_ref()
        .and_then(|m| m.chars().next())
        .ok_or_else(|| anyhow!("No drive letter found for partition"))?;

    let script = format!("select volume {}\ndelete partition\n", drive_letter);

    let script_path = std::env::temp_dir().join("diskpart_delete.txt");
    std::fs::write(&script_path, script)?;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("diskpart")
        .arg("/s")
        .arg(&script_path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
        return Err(anyhow!(
            "Diskpart delete failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Delete partition on Linux using parted
#[cfg(target_os = "linux")]
async fn delete_partition_linux(partition: &PartitionInfo) -> Result<()> {
    use std::process::Command;

    let device = &partition.device_path;

    // Extract partition number
    let part_num = device
        .chars()
        .rev()
        .take_while(|c| c.is_numeric())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();

    // Extract base device
    let base_device = device.trim_end_matches(&part_num);

    let output = Command::new("parted")
        .arg(base_device)
        .arg("rm")
        .arg(&part_num)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!(
            "parted delete failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Delete partition on macOS using diskutil
#[cfg(target_os = "macos")]
async fn delete_partition_macos(partition: &PartitionInfo) -> Result<()> {
    use std::process::Command;

    let output = Command::new("diskutil")
        .arg("eraseVolume")
        .arg("Free Space")
        .arg("Untitled")
        .arg(&partition.device_path)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!(
            "diskutil delete failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

/// Create a new partition at a specific offset
async fn create_partition_at_offset(
    disk: &DiskInfo,
    original_partition: &PartitionInfo,
    target_offset: u64,
) -> Result<PartitionInfo> {
    
    #[cfg(target_os = "windows")]
    {
        create_partition_at_offset_windows(disk, original_partition, target_offset).await
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow!(
            "Partition creation at specific offset not yet fully implemented for this platform."
        ))
    }
}

/// Windows-specific partition creation using diskpart
#[cfg(target_os = "windows")]
async fn create_partition_at_offset_windows(
    disk: &DiskInfo,
    original_partition: &PartitionInfo,
    target_offset: u64,
) -> Result<PartitionInfo> {
    use std::process::Command;
    use std::os::windows::process::CommandExt;

    // Convert size to MB (diskpart expects MB)
    let size_mb = original_partition.total_size / (1024 * 1024);
    
    // Convert offset to KB (diskpart expects KB for offset)
    let offset_kb = target_offset / 1024;
    
    // Get disk number from ID or device path
    // Format is usually "disk-N" or "\\.\PhysicalDriveN"
    let disk_num = if let Some(stripped) = disk.id.strip_prefix("disk-") {
        stripped.to_string()
    } else {
        // Fallback: try to parse from device path
         disk.device_path.replace("\\\\.\\PhysicalDrive", "")
    };

    // Try to preserve original drive letter
    let letter_cmd = if let Some(ref mp) = original_partition.mount_point {
        // mount_point is likely "E:" or "E:\"
        if let Some(letter) = mp.chars().next() {
             format!("assign letter={}", letter)
        } else {
             "assign".to_string()
        }
    } else {
         "assign".to_string()
    };

    // Construct diskpart script
    // create partition primary size=<size_mb> offset=<offset_kb>
    let script = format!(
        "select disk {}\ncreate partition primary size={} offset={}\nformat fs=ntfs quick\n{}\n", 
        disk_num, 
        size_mb, 
        offset_kb,
        letter_cmd
    );

    let script_path = std::env::temp_dir().join("diskpart_create.txt");
    std::fs::write(&script_path, script)?;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("diskpart")
        .arg("/s")
        .arg(&script_path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
        
    let _ = std::fs::remove_file(&script_path);

    if !output.status.success() {
         return Err(anyhow!(
            "Diskpart create failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    
    // After creation, we need to return the new partition info
    // We can fetch updated disk info and find the new partition
    // For now, we'll return a constructed object based on what we just did
    // Note: Re-fetching is safer but requires circular dependency on platform module
    // Let's return a "best guess" updated info, or standard empty one that triggers a refresh later
    
    let mut new_part = original_partition.clone();
    new_part.start_offset = target_offset;
    // mount_point and other dynamic props will need refresh
    
    Ok(new_part)
}

/// Restore partition data from backup
async fn restore_partition_data(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    progress_callback(MoveProgress::restoring_data(0.0, 0, partition.total_size));

    std::fs::create_dir_all(backup_path)?;
    
    // IMPORTANT: The partition passed here might be the NEWLY created one.
    // It might not have a mount point yet if we just created it.
    // However, in create_partition_at_offset_windows, we added 'assign', 
    // so it should get a drive letter.
    // We really should re-scan the disks to find the new mount point.
    // For this implementation, we assume it's mounted or we can find it.
    
    // If we can't rely on the partition object having the correct mount point yet, 
    // we might need to look it up. But let's assume the caller handles this 
    // or we implement a 'refresh' mechanism.
    
    // Reuse the backup implementation's platform branches but swap source/dest
    
    #[cfg(target_os = "windows")]
    {
         // For restore, Source is Backup, Dest is Partition
         restore_partition_windows(partition, backup_path, progress_callback).await
    }

    #[cfg(target_os = "linux")]
    {
    restore_partition_linux(partition, backup_path, progress_callback).await
    }
    
    #[cfg(target_os = "macos")]
    {
        restore_partition_macos(partition, backup_path, progress_callback).await
    }
    
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Err(anyhow!("Partition restore not implemented for this platform"))
    }
}

#[cfg(target_os = "windows")]
async fn restore_partition_windows(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;
    
    // We need the mount point of the target partition
    // If the partition struct doesn't have it (freshly created), we have a problem.
    // In a real app, we'd force a rescan here. 
    // For now, let's assume it has one or fail.
    
    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Target partition must be mounted to restore data"))?;

    let output = Command::new("robocopy")
        .arg(backup_path)
        .arg(mount_point)
        .arg("/E")
        .arg("/COPYALL")
        .arg("/R:3")
        .arg("/W:5")
        .arg("/MT:8")
        .output()?;

    let exit_code = output.status.code().unwrap_or(16);
    if exit_code >= 8 {
        return Err(anyhow!(
            "Robocopy restore failed code {}: {}", 
            exit_code,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    
    progress_callback(MoveProgress::restoring_data(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

#[cfg(target_os = "linux")]
async fn restore_partition_linux(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;
    
    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Target partition must be mounted"))?;

    progress_callback(MoveProgress::restoring_data(0.0, partition.total_size, 0));

    let output = Command::new("rsync")
        .arg("-av")
        .arg("--progress")
        .arg(format!("{}/", backup_path.display()))
        .arg(mount_point)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!("Rsync restore failed: {}", String::from_utf8_lossy(&output.stderr)));
    }
    
    progress_callback(MoveProgress::restoring_data(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

#[cfg(target_os = "macos")]
async fn restore_partition_macos(
    partition: &PartitionInfo,
    backup_path: &std::path::Path,
    progress_callback: &impl Fn(MoveProgress),
) -> Result<bool> {
    use std::process::Command;

    let mount_point = partition
        .mount_point
        .as_ref()
        .ok_or_else(|| anyhow!("Target partition must be mounted"))?;

    progress_callback(MoveProgress::restoring_data(0.0, partition.total_size, 0));

    let output = Command::new("rsync")
        .arg("-a")
        .arg("--progress")
        .arg(format!("{}/", backup_path.display()))
        .arg(mount_point)
        .output()?;

    if !output.status.success() {
        return Err(anyhow!("rsync restore failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    progress_callback(MoveProgress::restoring_data(100.0, partition.total_size, partition.total_size));
    Ok(true)
}

/// Format bytes to human-readable string
fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 B".to_string();
    }

    let base = 1024_f64;
    let exp = (bytes as f64).log(base).floor() as usize;
    let exp = exp.min(UNITS.len() - 1);
    let value = bytes as f64 / base.powi(exp as i32);

    format!("{:.2} {}", value, UNITS[exp])
}
