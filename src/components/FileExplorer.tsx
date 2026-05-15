'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    makeStyles,
    shorthands,
    tokens,
    Button,
    Text,
    DataGrid,
    DataGridBody,
    DataGridRow,
    DataGridHeader,
    DataGridHeaderCell,
    DataGridCell,
    TableCellLayout,
    TableColumnDefinition,
    createTableColumn,
    ProgressBar,
    Tooltip,
    SelectionItemId,
    Menu,
    MenuList,
    MenuItem,
    MenuPopover,
    Spinner,
    Caption1,
    Dialog,
    DialogSurface,
    DialogBody,
    DialogTitle,
    DialogContent,
    DialogActions,
} from '@fluentui/react-components';
import {
    FolderRegular,
    DocumentRegular,
    ArrowUpRegular,
    ArrowLeftRegular,
    ArrowRightRegular,
    ArrowClockwiseRegular,
    OpenRegular,
    DeleteRegular,
    FolderOpenRegular,
    HomeRegular,
    HardDriveRegular,
    DataPieRegular,
    InfoRegular,
    DismissRegular,
    SparkleRegular,
    BroomRegular,
    WarningRegular,
    BoxToolboxRegular,
} from '@fluentui/react-icons';
import { DiskUsageChart } from './DiskUsageChart';
import { BreadcrumbPath } from './BreadcrumbPath';
import { CleanerPanel } from './CleanerPanel';
import ToolshedPanel from './ToolshedPanel';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { FileNode } from '@/types';
import { FileMetadata } from '@/types/ai-types';
import { ThemeToggle } from './ThemeToggle';

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        ...shorthands.gap('10px'),
        ...shorthands.padding('20px'),
    },
    toolbar: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
    },
    pathBar: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('10px'),
        flexGrow: 1,
    },
    gridContainer: {
        flexGrow: 1,
        overflowY: 'auto',
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
        ...shorthands.borderRadius('4px'),
    },
    statusBar: {
        display: 'flex',
        justifyContent: 'space-between',
        paddingTop: '8px',
        borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    },
});

interface ExplorerState {
    path: string;
    loading: boolean;
    data: FileNode | null;
    history: string[];
    historyIndex: number;
    error: string | null;
}

interface ScanProgressPayload {
    path: string;
    count: number;
    size: number;
    errors: number;
}

const ScanProgressBanner = ({ progress, onCancel, speed }: {
    progress: ScanProgressPayload;
    onCancel: () => void;
    speed: number;
}) => {
    const formatSize = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Determine if screen is wide (desktop) or compact
    const [isWideScreen, setIsWideScreen] = useState(window.innerWidth > 1024);

    useEffect(() => {
        const handleResize = () => {
            setIsWideScreen(window.innerWidth > 1024);
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const hasErrors = progress.errors > 0;

    if (isWideScreen) {
        // Full-width slim banner for desktop/laptop
        return (
            <div style={{
                width: '100%',
                backgroundColor: 'var(--colorNeutralBackground3)',
                borderRadius: '6px',
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: '16px',
                border: '1px solid var(--colorNeutralStroke1)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            }}>
                <Spinner size="tiny" />

                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0 }}>
                    <Text weight="medium" style={{ flexShrink: 0 }}>
                        Scanning
                    </Text>

                    <Text
                        style={{
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'var(--colorNeutralForeground2)',
                            fontSize: '13px'
                        }}
                        title={progress.path}
                    >
                        {progress.path}
                    </Text>
                </div>

                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    flexShrink: 0
                }}>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '13px', alignItems: 'center' }}>
                        <Text style={{ color: 'var(--colorNeutralForeground2)' }}>
                            {progress.count.toLocaleString()} items
                        </Text>
                        <Text style={{ color: 'var(--colorNeutralForeground2)' }}>
                            {formatSize(progress.size)}
                        </Text>
                        <Text style={{ color: 'var(--colorNeutralForeground2)' }}>
                            {Math.round(speed)}/sec
                        </Text>
                        {hasErrors && (
                            <Tooltip
                                content={`${progress.errors.toLocaleString()} directories or files could not be accessed due to permission restrictions. The displayed size represents accessible files only.`}
                                relationship="description"
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--colorPaletteYellowForeground1)' }}>
                                    <WarningRegular fontSize={16} />
                                    <Text style={{ color: 'var(--colorPaletteYellowForeground1)', fontSize: '13px' }}>
                                        {progress.errors.toLocaleString()} restricted
                                    </Text>
                                </div>
                            </Tooltip>
                        )}
                    </div>

                    <div style={{ width: '100px' }}>
                        <ProgressBar thickness="medium" />
                    </div>

                    <Button
                        appearance="subtle"
                        icon={<DismissRegular />}
                        onClick={onCancel}
                        size="small"
                    >
                        Cancel
                    </Button>
                </div>
            </div>
        );
    } else {
        // Compact corner toast for smaller screens
        return (
            <div style={{
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                width: '320px',
                backgroundColor: 'var(--colorNeutralBackground1)',
                borderRadius: '8px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                padding: '14px',
                zIndex: 1000,
                border: '1px solid var(--colorNeutralStroke1)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                    <Spinner size="tiny" />
                    <Text weight="semibold" size={300}>Scanning folder</Text>
                    <Button
                        appearance="subtle"
                        icon={<DismissRegular />}
                        onClick={onCancel}
                        size="small"
                        style={{ marginLeft: 'auto' }}
                    />
                </div>

                <Text
                    size={200}
                    style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--colorNeutralForeground2)',
                        marginBottom: '8px'
                    }}
                    title={progress.path}
                >
                    {progress.path}
                </Text>

                <ProgressBar style={{ marginBottom: '8px' }} />

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <Caption1 style={{ color: 'var(--colorNeutralForeground2)' }}>
                        {progress.count.toLocaleString()} items • {formatSize(progress.size)} • {Math.round(speed)}/sec
                    </Caption1>
                    {hasErrors && (
                        <Caption1 style={{ color: 'var(--colorPaletteYellowForeground1)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <WarningRegular fontSize={14} />
                            {progress.errors.toLocaleString()} items restricted
                        </Caption1>
                    )}
                </div>
            </div>
        );
    }
};

interface FileExplorerProps {
    onToggleAI?: () => void;
    isAIPanelOpen?: boolean;
    onContextChange?: (path: string, selectedItems: string[], visibleFiles?: FileMetadata[]) => void;
}

export const FileExplorer = ({ onToggleAI, isAIPanelOpen, onContextChange }: FileExplorerProps) => {
    const styles = useStyles();
    const [state, setState] = React.useState<ExplorerState>({
        path: 'C:\\',
        loading: false,
        data: null,
        history: ['C:\\'],
        historyIndex: 0,
        error: null,
    });

    const [selectedItems, setSelectedItems] = React.useState<Set<SelectionItemId>>(new Set());
    const [showChart, setShowChart] = React.useState(false);
    const [viewMode, setViewMode] = React.useState<'explorer' | 'cleaner' | 'toolshed'>('explorer');

    // Scan Progress State
    const [scanProgress, setScanProgress] = useState<ScanProgressPayload | null>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [scanSpeed, setScanSpeed] = useState(0);
    const lastProgressRef = useRef<{ count: number, time: number } | null>(null);
    const currentScanPathRef = useRef<string | null>(null); // Track which path is being scanned
    const scanCompletedRef = useRef<boolean>(false); // Flag to prevent race condition

    // Context synchronization
    React.useEffect(() => {
        if (onContextChange) {
            const selectedArray = Array.from(selectedItems).map(id => String(id));
            const visibleFiles = state.data?.children?.map(c => ({
                name: c.name,
                isDir: c.is_dir,
                size: c.size,
                fileCount: c.file_count,
                lastModified: c.last_modified
            })) || [];

            // Limit to top 100 files to avoid context overflow
            const contextFiles = visibleFiles.slice(0, 100);
            onContextChange(state.path, selectedArray, contextFiles);
        }
    }, [state.path, selectedItems, state.data, onContextChange]);

    // Context Menu State
    const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
    const [contextMenuLocation, setContextMenuLocation] = React.useState({ x: 0, y: 0 });
    const [contextMenuItem, setContextMenuItem] = React.useState<FileNode | null>(null);

    // Dialog State
    const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
    const [propertiesDialogOpen, setPropertiesDialogOpen] = React.useState(false);
    const [dialogItem, setDialogItem] = React.useState<FileNode | null>(null);
    const [dialogItems, setDialogItems] = React.useState<FileNode[] | null>(null);

    // Compute all selected item objects (multi-select)
    const selectedItemsList = React.useMemo(() => {
        if (selectedItems.size === 0) return [];
        return state.data?.children?.filter(c => selectedItems.has(c.path)) || [];
    }, [selectedItems, state.data]);

    const formatSize = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const columns: TableColumnDefinition<FileNode>[] = [
        createTableColumn({
            columnId: 'file',
            compare: (a, b) => a.name.localeCompare(b.name),
            renderHeaderCell: () => 'Name',
            renderCell: (item) => {
                let Icon = DocumentRegular;
                if (item.is_dir) {
                    Icon = FolderRegular;
                    // Check if it looks like a drive (Windows) or we are at root
                    if (item.path.match(/^[a-zA-Z]:\\$/) || (item.path === '/' && item.name !== 'Root /')) {
                        Icon = HardDriveRegular;
                    }
                }
                return (
                    <TableCellLayout media={<Icon />}>
                        {item.name}
                    </TableCellLayout>
                );
            },
        }),
        createTableColumn({
            columnId: 'size',
            compare: (a, b) => a.size - b.size,
            renderHeaderCell: () => 'Size',
            renderCell: (item) => formatSize(item.size),
        }),
        createTableColumn({
            columnId: 'count',
            compare: (a, b) => a.file_count - b.file_count,
            renderHeaderCell: () => 'Files',
            renderCell: (item) => (item.is_dir && state.path !== '') ? item.file_count.toLocaleString() : '-',
        }),
        createTableColumn({
            columnId: 'modified',
            compare: (a, b) => a.last_modified - b.last_modified,
            renderHeaderCell: () => 'Modified',
            renderCell: (item) => new Date(item.last_modified * 1000).toLocaleString(),
        }),
    ];

    const fetchData = async (path: string, forceRefresh: boolean = false) => {
        // Set the current scan path and reset completion flag
        currentScanPathRef.current = path;
        scanCompletedRef.current = false;

        setState(prev => ({ ...prev, loading: true, error: null }));
        setIsScanning(true);
        setScanProgress(null);
        setScanSpeed(0);
        lastProgressRef.current = null;

        try {
            if (path === '') {
                // Fetch Drives
                const drives = await invoke<FileNode[]>('get_drives');

                // Mark scan as completed BEFORE clearing state
                scanCompletedRef.current = true;
                currentScanPathRef.current = null;

                setState(prev => ({
                    ...prev,
                    loading: false,
                    // Construct a fake root node to hold drives
                    data: {
                        name: 'This PC',
                        path: '',
                        size: 0,
                        is_dir: true,
                        children: drives,
                        last_modified: 0,
                        file_count: drives.length
                    },
                    path: ''
                }));
                setSelectedItems(new Set());
                setIsScanning(false);
                setScanProgress(null);
                setScanSpeed(0);
                return;
            }

            const command = forceRefresh ? 'refresh_scan' : 'scan_dir';
            const data = await invoke<FileNode>(command, { path });

            // Mark scan as completed BEFORE clearing state - this prevents race condition
            scanCompletedRef.current = true;
            currentScanPathRef.current = null;

            // Immediately clear scanning state when data arrives
            setIsScanning(false);
            setScanProgress(null);
            setScanSpeed(0);
            lastProgressRef.current = null;

            // Then update the UI with the new data
            setState(prev => ({ ...prev, loading: false, data, path }));
            setSelectedItems(new Set()); // Clear selection on navigate
        } catch (e: unknown) {
            // Mark as completed even on error
            scanCompletedRef.current = true;
            currentScanPathRef.current = null;

            setState(prev => ({ ...prev, loading: false, error: String(e) }));
            // Clear scanning state on error too
            setIsScanning(false);
            setScanProgress(null);
            setScanSpeed(0);
            lastProgressRef.current = null;
        }
    };

    React.useEffect(() => {
        const initialPath = ''; // Start at Home (Drives)
        setState(prev => ({
            ...prev,
            history: [initialPath],
            historyIndex: 0,
            path: initialPath,
            loading: true
        }));
        fetchData(initialPath);

        const unlistenPromise = listen<ScanProgressPayload>('scan-progress', (event) => {
            // CRITICAL: Ignore progress events after scan is completed or for different paths
            if (scanCompletedRef.current) {
                return;
            }

            if (currentScanPathRef.current !== event.payload.path) {
                return;
            }

            const now = Date.now();
            const currentCount = event.payload.count;

            if (lastProgressRef.current) {
                const deltaCount = currentCount - lastProgressRef.current.count;
                const deltaTime = (now - lastProgressRef.current.time) / 1000;
                if (deltaTime > 0.3) { // Update speed every 300ms for smoother updates
                    const newSpeed = deltaCount / deltaTime;
                    // Only update speed if it's meaningful (avoid showing 0 during scanning)
                    if (newSpeed > 0) {
                        setScanSpeed(newSpeed);
                    }
                    lastProgressRef.current = { count: currentCount, time: now };
                }
            } else {
                lastProgressRef.current = { count: currentCount, time: now };
            }

            setScanProgress(event.payload);
            setIsScanning(true);
        });

        return () => {
            unlistenPromise.then(unlisten => unlisten());
        };
    }, []);

    const handleNavigate = (newPath: string) => {
        if (newPath === state.path) return;

        const newHistory = state.history.slice(0, state.historyIndex + 1);
        newHistory.push(newPath);

        setState(prev => ({
            ...prev,
            history: newHistory,
            historyIndex: newHistory.length - 1,
        }));

        fetchData(newPath);
    };

    const handleBack = () => {
        if (state.historyIndex > 0) {
            const newIndex = state.historyIndex - 1;
            const prevPath = state.history[newIndex];
            setState(prev => ({ ...prev, historyIndex: newIndex }));
            fetchData(prevPath);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const handleForward = () => {
        if (state.historyIndex < state.history.length - 1) {
            const newIndex = state.historyIndex + 1;
            const nextPath = state.history[newIndex];
            setState(prev => ({ ...prev, historyIndex: newIndex }));
            fetchData(nextPath);
        }
    };

    // Up one level logic
    const handleUp = () => {
        let separator = '/';
        if (state.path.includes('\\')) separator = '\\';

        // Handle root cases primarily for UNIX
        if (state.path === '/' || state.path === '\\') return;

        const parts = state.path.split(separator).filter(Boolean);
        if (parts.length > 0) {
            parts.pop();
            const parentPath = parts.length === 0 ? '/' : parts.join(separator);
            const finalPath = parentPath === '' ? '/' : (state.path.startsWith('/') ? '/' + parentPath : parentPath);
            handleNavigate(finalPath);
        }
    };

    const confirmDelete = async () => {
        const items = dialogItems;
        if (!items || items.length === 0) return;
        try {
            for (const item of items) {
                await invoke('delete_item', { path: item.path });
            }
            fetchData(state.path, true);
            setDeleteDialogOpen(false);
            setDialogItems(null);
        } catch (e) {
            console.error(`Failed to delete: ${e}`);
            alert(`Failed to delete: ${e}`);
        }
    };

    const handleRevealInExplorer = async (item: FileNode) => {
        try {
            await invoke('reveal_in_explorer', { path: item.path });
        } catch (e) {
            console.error(e);
        }
    };

    const handleOpenFile = async (item: FileNode) => {
        if (item.is_dir) {
            handleNavigate(item.path);
        } else {
            try {
                await invoke('open_file', { path: item.path });
            } catch (e) {
                console.error(e);
            }
        }
    };

    // Show basic properties of a file/folder in a dialog
    const handlePropertiesClick = (item: FileNode) => {
        setDialogItem(item);
        setPropertiesDialogOpen(true);
    };

    const handleCancelScan = async () => {
        // Mark as completed to stop accepting progress events
        scanCompletedRef.current = true;
        currentScanPathRef.current = null;

        await invoke('cancel_scan');
        setIsScanning(false);
        setScanProgress(null);
        setScanSpeed(0);
        lastProgressRef.current = null;
    };

    const items = state.data?.children || [];

    return (
        <div className={styles.container}>
            {/* Toolbar */}
            <div className={styles.toolbar}>
                <Tooltip content="Home" relationship="label">
                    <Button icon={<HomeRegular />} onClick={() => handleNavigate('')} />
                </Tooltip>

                <Tooltip content="Back" relationship="label">
                    <Button icon={<ArrowLeftRegular />} disabled={state.historyIndex <= 0} onClick={handleBack} />
                </Tooltip>
                <Tooltip content="Open Selected Folder" relationship="label">
                    <Button
                        icon={<ArrowRightRegular />}
                        disabled={selectedItemsList.length !== 1 || !selectedItemsList[0]?.is_dir}
                        onClick={() => selectedItemsList[0] && handleNavigate(selectedItemsList[0].path)}
                    />
                </Tooltip>
                {/* <Tooltip content="Up" relationship="label">
                    <Button icon={<ArrowUpRegular />} onClick={handleUp} />
                </Tooltip> */}
                <Tooltip content="Refresh" relationship="label">
                    <Button icon={<ArrowClockwiseRegular />} onClick={() => fetchData(state.path, true)} />
                </Tooltip>

                <div style={{ width: '1px', height: '20px', background: tokens.colorNeutralStroke1 }} />

                <Tooltip content="Toggle Disk Usage Chart" relationship="label">
                    <Button
                        icon={<DataPieRegular />}
                        appearance={showChart ? "primary" : "secondary"}
                        onClick={() => setShowChart(!showChart)}
                        disabled={viewMode !== 'explorer'}
                    />
                </Tooltip>

                <Tooltip content="Toolshed" relationship="label">
                    <Button
                        icon={<BoxToolboxRegular />}
                        appearance={viewMode === 'toolshed' ? "primary" : "secondary"}
                        onClick={() => setViewMode(viewMode === 'toolshed' ? 'explorer' : 'toolshed')}
                    />
                </Tooltip>

                <Tooltip content="Toggle AI Assistant" relationship="label">
                    <Button
                        icon={<SparkleRegular />}
                        appearance={isAIPanelOpen ? "primary" : "secondary"}
                        onClick={onToggleAI}
                        disabled={!onToggleAI}
                    />
                </Tooltip>

                <ThemeToggle />

                <div className={styles.pathBar}>
                    <BreadcrumbPath
                        path={state.path}
                        onNavigate={handleNavigate}
                    />
                </div>
            </div>

            {state.loading && !isScanning && <ProgressBar />}
            {state.error && <Text style={{ color: 'red' }}>{state.error}</Text>}

            {/* SCAN PROGRESS BANNER */}
            {isScanning && scanProgress && (
                <ScanProgressBanner
                    progress={scanProgress}
                    speed={scanSpeed}
                    onCancel={handleCancelScan}
                />
            )}

            {/* Main Content Area (Grid + Chart + Toolshed) */}
            <div style={{ display: 'flex', flexGrow: 1, overflow: 'hidden', gap: '10px' }}>
                {viewMode === 'toolshed' ? (
                    <div style={{ flexGrow: 1, height: '100%', overflow: 'hidden' }}>
                        <ToolshedPanel />
                    </div>
                ) : viewMode === 'cleaner' ? (
                    <div style={{ flexGrow: 1, height: '100%', overflow: 'hidden' }}>
                        <CleanerPanel />
                    </div>
                ) : (
                    <>
                        {/* Grid */}
                        <div className={styles.gridContainer} style={{ flexGrow: 1, width: showChart ? '60%' : '100%' }}>
                            <DataGrid
                                items={items}
                                columns={columns}
                                sortable
                                selectionMode="multiselect"
                                selectedItems={selectedItems}
                                onSelectionChange={(e, data) => setSelectedItems(data.selectedItems)}
                                getRowId={(item) => item.path}
                            >
                                <DataGridHeader>
                                    <DataGridRow>
                                        {({ renderHeaderCell }) => (
                                            <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                                        )}
                                    </DataGridRow>
                                </DataGridHeader>
                                <DataGridBody<FileNode>>
                                    {({ item, rowId }) => (
                                        <DataGridRow<FileNode>
                                            key={rowId}
                                            onContextMenu={(e: React.MouseEvent) => {
                                                e.preventDefault();
                                                setContextMenuItem(item);
                                                setContextMenuLocation({ x: e.clientX, y: e.clientY });
                                                setContextMenuOpen(true);
                                                // If item not already selected, select only this one
                                                if (!selectedItems.has(item.path)) {
                                                    setSelectedItems(new Set([item.path]));
                                                }
                                            }}
                                            onDoubleClick={() => handleOpenFile(item)}
                                            onKeyDown={(e: React.KeyboardEvent) => {
                                                if (e.key === 'Enter') {
                                                    handleOpenFile(item);
                                                }
                                            }}
                                        >
                                            {({ renderCell }) => (
                                                <DataGridCell>{renderCell(item)}</DataGridCell>
                                            )}
                                        </DataGridRow>
                                    )}
                                </DataGridBody>
                            </DataGrid>

                            {/* Context Menu */}
                            <Menu
                                open={contextMenuOpen}
                                onOpenChange={(e, data) => setContextMenuOpen(data.open)}
                                positioning={{
                                    target: {
                                        getBoundingClientRect: () => ({
                                            top: contextMenuLocation.y,
                                            left: contextMenuLocation.x,
                                            right: contextMenuLocation.x,
                                            bottom: contextMenuLocation.y,
                                            width: 0,
                                            height: 0,
                                            x: contextMenuLocation.x,
                                            y: contextMenuLocation.y,
                                            toJSON: () => { },
                                        }),
                                    },
                                }}
                            >
                                <MenuPopover>
                                    <MenuList>
                                        <MenuItem
                                            icon={<OpenRegular />}
                                            onClick={() => contextMenuItem && handleOpenFile(contextMenuItem)}
                                            disabled={selectedItemsList.length !== 1}
                                        >
                                            Open
                                        </MenuItem>
                                        <MenuItem icon={<FolderOpenRegular />} onClick={() => contextMenuItem && handleRevealInExplorer(contextMenuItem)}>
                                            Reveal in Explorer/Finder
                                        </MenuItem>
                                        <MenuItem
                                            icon={<InfoRegular />}
                                            onClick={() => contextMenuItem && handlePropertiesClick(contextMenuItem)}
                                            disabled={selectedItemsList.length !== 1}
                                        >
                                            Properties
                                        </MenuItem>
                                        <MenuItem icon={<DeleteRegular />} onClick={() => {
                                            if (selectedItemsList.length > 1) {
                                                setDialogItems(selectedItemsList);
                                            } else if (contextMenuItem) {
                                                setDialogItems([contextMenuItem]);
                                            }
                                            setDeleteDialogOpen(true);
                                        }}>
                                            {selectedItemsList.length > 1
                                                ? `Delete ${selectedItemsList.length} items`
                                                : 'Delete'
                                            }
                                        </MenuItem>
                                    </MenuList>
                                </MenuPopover>
                            </Menu>

                            {/* Properties Dialog */}
                            <Dialog open={propertiesDialogOpen} onOpenChange={(event, data) => setPropertiesDialogOpen(data.open)}>
                                <DialogSurface>
                                    <DialogBody>
                                        <DialogTitle>Properties</DialogTitle>
                                        <DialogContent>
                                            {dialogItem && (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                                        {dialogItem.is_dir ? <FolderRegular fontSize={24} /> : <DocumentRegular fontSize={24} />}
                                                        <Text weight="semibold" size={500}>{dialogItem.name}</Text>
                                                    </div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '5px' }}>
                                                        <Text weight="medium">Type:</Text>
                                                        <Text>{dialogItem.is_dir ? 'Folder' : 'File'}</Text>

                                                        <Text weight="medium">Location:</Text>
                                                        <Text style={{ wordBreak: 'break-all' }}>{dialogItem.path}</Text>

                                                        <Text weight="medium">Size:</Text>
                                                        <Text>{formatSize(dialogItem.size)} ({dialogItem.size.toLocaleString()} bytes)</Text>

                                                        <Text weight="medium">Modified:</Text>
                                                        <Text>{new Date(dialogItem.last_modified * 1000).toLocaleString()}</Text>

                                                        {dialogItem.is_dir && (
                                                            <>
                                                                <Text weight="medium">Contains:</Text>
                                                                <Text>{dialogItem.file_count.toLocaleString()} Files</Text>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </DialogContent>
                                        <DialogActions>
                                            <Button appearance="primary" onClick={() => setPropertiesDialogOpen(false)}>Close</Button>
                                        </DialogActions>
                                    </DialogBody>
                                </DialogSurface>
                            </Dialog>

                            {/* Delete Confirmation Dialog */}
                            <Dialog open={deleteDialogOpen} onOpenChange={(event, data) => {
                                setDeleteDialogOpen(data.open);
                                if (!data.open) setDialogItems(null);
                            }}>
                                <DialogSurface>
                                    <DialogBody>
                                        <DialogTitle>Confirm Delete</DialogTitle>
                                        <DialogContent>
                                            {dialogItems && dialogItems.length === 1 ? (
                                                <>
                                                    <Text>
                                                        Are you sure you want to permanently delete <strong>{dialogItems[0].name}</strong>?
                                                    </Text>
                                                    {dialogItems[0].is_dir && (
                                                        <Text block style={{ marginTop: '10px', color: 'var(--colorPaletteRedForeground1)' }}>
                                                            Warning: This is a folder. All contents will be deleted.
                                                        </Text>
                                                    )}
                                                </>
                                            ) : (
                                                <>
                                                    <Text>
                                                        Are you sure you want to permanently delete <strong>{dialogItems?.length}</strong> items?
                                                    </Text>
                                                    <Text block style={{ marginTop: '10px', color: 'var(--colorPaletteRedForeground1)' }}>
                                                        Warning: This action cannot be undone.
                                                    </Text>
                                                </>
                                            )}
                                        </DialogContent>
                                        <DialogActions>
                                            <Button appearance="secondary" onClick={() => { setDeleteDialogOpen(false); setDialogItems(null); }}>Cancel</Button>
                                            <Button appearance="primary" style={{ backgroundColor: '#d13438', color: 'white' }} onClick={confirmDelete}>Delete</Button>
                                        </DialogActions>
                                    </DialogBody>
                                </DialogSurface>
                            </Dialog>
                        </div>

                        {/* Chart Panel */}
                        {showChart && items.length > 0 && (
                            <div style={{ width: '40%', minWidth: '300px', display: 'flex', flexDirection: 'column' }}>
                                <DiskUsageChart items={items} />
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Status Bar */}
            <div className={styles.statusBar}>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <Text>{items.length} items</Text>
                    {selectedItems.size > 0 && (
                        <>
                            <div style={{ width: '1px', height: '14px', background: tokens.colorNeutralStroke2 }} />
                            <Text weight="semibold">{selectedItems.size} selected</Text>
                            <Button
                                appearance="subtle"
                                size="small"
                                onClick={() => setSelectedItems(new Set())}
                            >
                                Clear
                            </Button>
                        </>
                    )}
                </div>
                <Text>Total Size: {formatSize(state.data?.size || 0)}</Text>
            </div>
        </div>
    );
};
