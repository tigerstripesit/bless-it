// use jwalk::WalkDir;
use serde::{Deserialize, Serialize};
use std::time::SystemTime;
use rayon::prelude::*;
use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
    pub last_modified: u64,
    pub file_count: u64,
}

pub struct ScanStats {
    pub scanned_files: AtomicU64,
    pub total_size: AtomicU64,
    pub errors: AtomicU64,
}

pub fn scan_directory(
    path: &str,
    stats: Option<Arc<ScanStats>>,
    cancel: Option<Arc<AtomicBool>>
) -> Result<FileNode, String> {
    let root_path = std::path::Path::new(path);
    if !root_path.exists() {
        return Err("Directory does not exist".to_string());
    }

    if let Some(c) = &cancel {
        if c.load(Ordering::Relaxed) {
             return Err("Cancelled".to_string());
        }
    }

    // 1. List immediate children of the requested path
    let read_dir = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    
    // Partition
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    
    for entry in entries {
        if let Some(c) = &cancel {
            if c.load(Ordering::Relaxed) { return Err("Cancelled".to_string()); }
        }

        if let Ok(metadata) = entry.metadata() {
            if metadata.is_dir() {
                dirs.push(entry);
            } else {
                files.push((entry, metadata));
            }
        }
    }
    
    let mut total_size = 0;
    let mut file_count = 0;
    
    // Files in root
    for (_entry, meta) in &files {
        let size = meta.len();
        total_size += size;
        file_count += 1;
        
        if let Some(s) = &stats {
            s.scanned_files.fetch_add(1, Ordering::Relaxed);
            s.total_size.fetch_add(size, Ordering::Relaxed);
        }
    }
    
    // 2. Process subdirectories in parallel (Lookahead scan)
    // We want to return a node for each directory that INCLUDES its own children list
    // This allows the caller to cache these nodes effectively.
    let dir_results_res: Result<Vec<FileNode>, String> = dirs.par_iter().map(|entry| {
        if let Some(c) = &cancel {
             if c.load(Ordering::Relaxed) { return Err("Cancelled".to_string()); }
        }

        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        let name = entry.file_name().to_string_lossy().to_string();
        
        let metadata = entry.metadata().unwrap();
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();

        // LOOKAHEAD: Scan the children of this subdirectory 
        // to populate its `children` field and calculate exact size.
        let (size, count, children) = scan_subdir_details(&path, stats.clone(), cancel.clone())?;

        Ok(FileNode {
            name,
            path: path_str,
            size,
            is_dir: true,
            children: Some(children), // We now populate this!
            last_modified: modified,
            file_count: count,
        })
    }).collect();
    
    let dir_results = dir_results_res?;
    
    // Aggregate totals
    for dir in &dir_results {
        total_size += dir.size;
        file_count += dir.file_count;
    }

    // Convert files in root to FileNodes
    let mut file_nodes: Vec<FileNode> = files.iter().map(|(entry, meta)| {
        let name = entry.file_name().to_string_lossy().to_string();
        let path_str = entry.path().to_string_lossy().to_string();
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)
            .duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs();

        FileNode {
            name,
            path: path_str,
            size: meta.len(),
            is_dir: false,
            children: None,
            last_modified: modified,
            file_count: 1,
        }
    }).collect();
    
    // Combine dirs and files
    let mut children_nodes = dir_results;
    children_nodes.append(&mut file_nodes);
    
    // Sort by size descending
    children_nodes.sort_by(|a, b| b.size.cmp(&a.size));
    
    Ok(FileNode {
        name: root_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        path: path.to_string(), // Keep original path string for consistency
        size: total_size,
        is_dir: true,
        children: Some(children_nodes),
        last_modified: 0,
        file_count,
    })
}

// Scans a subdirectory: Lists ITS children, and calculates their sizes (deep)
fn scan_subdir_details(
    path: &std::path::Path, 
    stats: Option<Arc<ScanStats>>, 
    cancel: Option<Arc<AtomicBool>>
) -> Result<(u64, u64, Vec<FileNode>), String> {
    // List children of this subdirectory
    
    let mut total_size = 0;
    let mut total_count = 0;
    let mut children_nodes = Vec::new();

    if let Ok(read_dir) = std::fs::read_dir(path) {
        let entries: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();

        // Split into files/dirs
        let mut sub_files_size = 0;
        let mut sub_files_count = 0;
        let mut sub_dirs = Vec::new();
        let mut sub_files: Vec<(std::fs::DirEntry, std::fs::Metadata)> = Vec::new();

        for entry in entries {
            if let Some(c) = &cancel {
                 if c.load(Ordering::Relaxed) { return Err("Cancelled".to_string()); }
            }

             if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    sub_dirs.push(entry);
                } else {
                    let s = meta.len();
                    sub_files_size += s;
                    sub_files_count += 1;

                    if let Some(st) = &stats {
                        st.scanned_files.fetch_add(1, Ordering::Relaxed);
                        st.total_size.fetch_add(s, Ordering::Relaxed);
                    }

                    sub_files.push((entry, meta));
                }
             }
        }

        total_size += sub_files_size;
        total_count += sub_files_count;

        // Process these subdirectories (Deep scan for size)
        let sub_dir_nodes_res: Result<Vec<FileNode>, String> = sub_dirs.par_iter().map(|entry| {
             if let Some(c) = &cancel {
                 if c.load(Ordering::Relaxed) { return Err("Cancelled".to_string()); }
             }

             let p = entry.path();
             let name = entry.file_name().to_string_lossy().to_string();
             let p_str = p.to_string_lossy().to_string();

             // Get stats using walkdir (Deep scan)
             let (s, c) = get_deep_stats(&p, stats.clone(), cancel.clone())?;

             let m = entry.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()).unwrap_or(0);

             Ok(FileNode {
                 name,
                 path: p_str,
                 size: s,
                 is_dir: true,
                 children: None, // We stop lookahead at 1 level deep to avoid recursion explosion
                 last_modified: m,
                 file_count: c,
             })
        }).collect();

        let sub_dir_nodes = sub_dir_nodes_res?;

        for node in &sub_dir_nodes {
            total_size += node.size;
            total_count += node.file_count;
        }

        children_nodes = sub_dir_nodes;

        // Include file children so the cached lookahead matches a direct scan.
        // Without this, navigating into a leaf folder (files only) returns
        // an empty list until the user hits refresh.
        let file_nodes: Vec<FileNode> = sub_files.iter().map(|(entry, meta)| {
            let name = entry.file_name().to_string_lossy().to_string();
            let p_str = entry.path().to_string_lossy().to_string();
            let m = meta.modified().ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            FileNode {
                name,
                path: p_str,
                size: meta.len(),
                is_dir: false,
                children: None,
                last_modified: m,
                file_count: 1,
            }
        }).collect();
        children_nodes.extend(file_nodes);

        children_nodes.sort_by(|a, b| b.size.cmp(&a.size));
    }

    Ok((total_size, total_count, children_nodes))
}

fn get_deep_stats(
    path: &std::path::Path, 
    stats: Option<Arc<ScanStats>>, 
    cancel: Option<Arc<AtomicBool>>
) -> Result<(u64, u64), String> {
    let mut size = 0;
    let mut count = 0;
    
    // Using simple walkdir; we should periodically check cancel
    for (idx, entry) in walkdir::WalkDir::new(path).min_depth(1).into_iter().enumerate() {
        if idx % 100 == 0 {
             if let Some(c) = &cancel {
                 if c.load(Ordering::Relaxed) { return Err("Cancelled".to_string()); }
             }
        }

        match entry {
            Ok(entry) => {
                if entry.file_type().is_file() {
                    let s = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    size += s;
                    count += 1;

                    if let Some(st) = &stats {
                        st.scanned_files.fetch_add(1, Ordering::Relaxed);
                        st.total_size.fetch_add(s, Ordering::Relaxed);
                    }
                }
            }
            Err(_e) => {
                // Track permission denied and other errors
                if let Some(st) = &stats {
                    st.errors.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }
    
    Ok((size, count))
}
