'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { FileSystemContext, FileMetadata } from '@/types/ai-types';
import { FileExplorer } from '@/components/FileExplorer';
import { AIPanel } from '@/components/AIPanel';
import { BrowserView } from '@/components/BrowserView';
import { WorkflowsPanel } from '@/components/WorkflowsPanel';
import ToolshedPanel from '@/components/ToolshedPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { featureFlags } from '@/lib/featureFlags';
import { makeStyles, shorthands, tokens, Tab, TabList, Button, Tooltip, type SelectTabEvent, type SelectTabData } from '@fluentui/react-components';
import { SparkleRegular } from '@fluentui/react-icons';

type Workspace = 'files' | 'toolshed' | 'browser' | 'workflows';

const useStyles = makeStyles({
  container: {
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    display: 'flex',
    position: 'relative',
  },
  explorerContainer: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  workspaceTabs: {
    flexShrink: 0,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '12px',
    paddingRight: '20px',
    background: tokens.colorNeutralBackground1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  globalActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
  },
  workspaceBody: {
    flex: 1,
    minHeight: '0px',
    overflow: 'hidden',
  },
  aiPanelContainer: {
    height: '100%',
    transition: 'width 0.2s ease, opacity 0.2s ease', // Smooth open/close, immediate resize via state
    overflow: 'hidden',
    ...shorthands.borderLeft('1px', 'solid', tokens.colorNeutralStroke1),
    background: tokens.colorNeutralBackground1,
  },
  resizeHandle: {
    width: '4px',
    cursor: 'col-resize',
    height: '100%',
    background: 'transparent',
    transition: 'background 0.2s',
    zIndex: 100,
    position: 'relative',
    marginRight: '-2px',
    marginLeft: '-2px',
    flexShrink: 0, // Prevent handle from shrinking
    ':hover': {
      background: tokens.colorBrandBackground,
    },
  },
});

export default function Home() {
  const styles = useStyles();
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const [isManualResize, setIsManualResize] = useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // AI Context State
  const [fsContext, setFsContext] = useState<FileSystemContext | undefined>(undefined);
  const [aiPanelPrefill, setAiPanelPrefill] = useState<string>('');

  const [workspace, setWorkspace] = useState<Workspace>('files');
  const [recordingActive, setRecordingActive] = useState(false);
  const [replayActive, setReplayActive] = useState(false);

  // Auto-switch to the Browser tab when the agent opens a session or gets a frame.
  useEffect(() => {
    if (!featureFlags.browserAgent) return;
    const switchToBrowser = () => {
      setWorkspace((w) => (w !== 'workflows' ? 'browser' : w));
    };
    window.addEventListener('browser-session-opened', switchToBrowser);
    window.addEventListener('browser-view-update', switchToBrowser);
    return () => {
      window.removeEventListener('browser-session-opened', switchToBrowser);
      window.removeEventListener('browser-view-update', switchToBrowser);
    };
  }, []);

  // Show browser split + open AI panel when workflow recording starts.
  useEffect(() => {
    if (!featureFlags.browserAgent) return;
    const onStart = () => {
      setRecordingActive(true);
      setAiPanelPrefill('Browser is open and recording. Tell me what to do — e.g. "Navigate to okta.com and unlock user john@example.com"');
      setIsAIPanelOpen(true);
    };
    const onStop = () => setRecordingActive(false);
    window.addEventListener('workflow-recording-started', onStart);
    window.addEventListener('workflow-recording-stopped', onStop);
    return () => {
      window.removeEventListener('workflow-recording-started', onStart);
      window.removeEventListener('workflow-recording-stopped', onStop);
    };
  }, []);

  // Show BrowserView screencast alongside the Workflows panel during replay.
  useEffect(() => {
    if (!featureFlags.browserAgent) return;
    const onStart = () => setReplayActive(true);
    const onStop = () => setReplayActive(false);
    window.addEventListener('workflow-replay-started', onStart);
    window.addEventListener('workflow-replay-stopped', onStop);
    return () => {
      window.removeEventListener('workflow-replay-started', onStart);
      window.removeEventListener('workflow-replay-stopped', onStop);
    };
  }, []);

  const onWorkspaceChange = useCallback((_e: SelectTabEvent, data: SelectTabData) => {
    setWorkspace(data.value as Workspace);
  }, []);

  const startResizing = React.useCallback(() => {
    if (panelRef.current) {
      setPanelWidth(panelRef.current.clientWidth);
    }
    setIsResizing(true);
    // Don't set manual resize immediately to avoid jump if just clicking without dragging?
    // Actually we need it true so width switches to px mode.
    // By setting panelWidth to current clientWidth first, the switch should be seamless.
    setIsManualResize(true);
  }, []);

  const stopResizing = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = React.useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing) {
        const newWidth = window.innerWidth - mouseMoveEvent.clientX;
        if (newWidth > 300 && newWidth < 800) {
          setPanelWidth(newWidth);
        }
      }
    },
    [isResizing]
  );

  const handleContextChange = React.useCallback((path: string, selectedItems: string[], visibleFiles?: FileMetadata[]) => {
    setFsContext({
      currentPath: path,
      selectedPaths: selectedItems,
      visibleFiles: visibleFiles,
    });
  }, []);

  const handleAskAgent = useCallback((selectedPaths: string[], currentPath: string) => {
    const paths = selectedPaths.map(p => `${currentPath}/${p}`).join('\n');
    setAiPanelPrefill(paths);
    if (!isAIPanelOpen) {
      setIsAIPanelOpen(true);
    }
  }, [isAIPanelOpen]);

  const toggleAIPanel = () => {
    const newState = !isAIPanelOpen;
    setIsAIPanelOpen(newState);
    if (!newState) {
      // Reset manual resize when closing, so next open is "optimal" again
      setIsManualResize(false);
    }
  };

  React.useEffect(() => {
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [resize, stopResizing]);

  return (
    <main className={styles.container}>
      <div className={styles.explorerContainer}>
        <div className={styles.workspaceTabs}>
          <TabList
            selectedValue={workspace}
            onTabSelect={onWorkspaceChange}
          >
            <Tab value="files">Files</Tab>
            <Tab value="toolshed">Toolshed</Tab>
            {featureFlags.browserAgent && <Tab value="browser">Browser</Tab>}
            {featureFlags.browserAgent && <Tab value="workflows">Workflows</Tab>}
          </TabList>
          <div className={styles.globalActions}>
            <Tooltip content="Toggle AI Assistant" relationship="label">
              <Button
                icon={<SparkleRegular />}
                appearance={isAIPanelOpen ? 'primary' : 'subtle'}
                onClick={toggleAIPanel}
              />
            </Tooltip>
            <ThemeToggle />
          </div>
        </div>
        <div
          className={styles.workspaceBody}
          style={(workspace === 'workflows' && (recordingActive || replayActive)) ? { display: 'flex', flexDirection: 'row' } : undefined}
        >
          {workspace === 'files' && (
            <FileExplorer
              onContextChange={handleContextChange}
              onAskAgent={handleAskAgent}
            />
          )}
          {workspace === 'toolshed' && <ToolshedPanel />}
          {/* WorkflowsPanel — narrows to 300 px sidebar when recording or replaying. */}
          {workspace === 'workflows' && (
            <div style={{
              width: (recordingActive || replayActive) ? '300px' : '100%',
              flexShrink: 0,
              height: '100%',
              overflow: 'auto',
              borderRight: (recordingActive || replayActive) ? `1px solid ${tokens.colorNeutralStroke2}` : 'none',
              transition: 'width 0.2s ease',
            }}>
              <WorkflowsPanel />
            </div>
          )}
          {/* BrowserView stays mounted so its screenshot state survives tab switches.
              Also shown as the right pane during recording and replay. */}
          {featureFlags.browserAgent && (
            <div style={{
              display: (workspace === 'browser' || (workspace === 'workflows' && (recordingActive || replayActive))) ? 'block' : 'none',
              ...(workspace === 'workflows' && (recordingActive || replayActive)
                ? { flex: 1, minWidth: 0, height: '100%' }
                : { width: '100%', height: '100%' }
              ),
            }}>
              <BrowserView />
            </div>
          )}
        </div>
      </div>

      {isAIPanelOpen && (
        <div
          className={styles.resizeHandle}
          onMouseDown={startResizing}
        />
      )}

      <div
        ref={panelRef}
        className={styles.aiPanelContainer}
        style={{
          width: isAIPanelOpen
            ? (isManualResize ? `${panelWidth}px` : '45vw')
            : '0px',
          minWidth: isAIPanelOpen ? 'auto' : '0px',
          maxWidth: isAIPanelOpen ? '70vw' : '0px',
          opacity: isAIPanelOpen ? 1 : 0,
          pointerEvents: isAIPanelOpen ? 'auto' : 'none',
        }}
      >
        <AIPanel
          isOpen={isAIPanelOpen}
          onClose={toggleAIPanel}
          fsContext={fsContext}
          prefillInput={aiPanelPrefill}
        />
      </div>
    </main>
  );
}
