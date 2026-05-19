'use client';

import React, { useState, useRef, useEffect } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';
import {
    CheckmarkCircle16Filled,
    ErrorCircle16Filled,
    DismissCircle16Filled,
    ArrowSync16Regular,
    Pause16Regular,
    Sparkle16Regular,
    Bot16Regular,
    Person16Regular,
    ChevronDown12Regular,
    ChevronUp12Regular,
} from '@fluentui/react-icons';
import type { StepRunStatus, ActorKind, AgentUsage } from '@/types/workflow-types';

interface StepRowProps {
    index: number;
    intent: string;
    tool: string;
    actor: ActorKind;
    classification: string;
    status: StepRunStatus;
    attemptCount: number;
    maxAuto: number;
    /** Accumulated action log lines — shown as live feed when active, collapsible when done. */
    agentLogs?: string[];
    errorMessage?: string;
    screenshot?: string;
    observedUrl?: string;
    agentModel?: string;
    agentUsage?: AgentUsage;
}

const ACTOR_ICON: Record<ActorKind, React.ReactNode> = {
    auto: <Bot16Regular />,
    agent: <Sparkle16Regular />,
    human: <Person16Regular />,
};

const ACTOR_COLOR: Record<ActorKind, string> = {
    auto: tokens.colorPaletteGreenForeground1,
    agent: tokens.colorPaletteBlueForeground2,
    human: tokens.colorPaletteGoldForeground2,
};

const useStyles = makeStyles({
    row: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '7px 10px',
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        ':last-child': { borderBottom: 'none' },
    },
    rowActive: {
        background: tokens.colorNeutralBackground2,
    },
    index: {
        width: '20px',
        textAlign: 'right',
        color: tokens.colorNeutralForeground3,
        fontSize: '12px',
        paddingTop: '2px',
        flexShrink: 0,
    },
    iconCol: {
        width: '18px',
        flexShrink: 0,
        paddingTop: '2px',
    },
    body: {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    },
    intentRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
    },
    meta: {
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
    },
    actorBadge: {
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        fontSize: '11px',
    },
    retryBadge: {
        fontSize: '10px',
        padding: '0 5px',
        borderRadius: '3px',
        background: tokens.colorPaletteYellowBackground2,
        color: tokens.colorPaletteYellowForeground2,
    },
    agentBadge: {
        fontSize: '10px',
        padding: '0 5px',
        borderRadius: '3px',
        background: tokens.colorPaletteBlueForeground2 + '20',
        color: tokens.colorPaletteBlueForeground2,
    },
    errorText: {
        fontSize: '11px',
        color: tokens.colorPaletteRedForeground1,
        marginTop: '2px',
    },
    // Terminal-style log area
    logArea: {
        marginTop: '6px',
        background: tokens.colorNeutralBackground4 ?? tokens.colorNeutralBackground3,
        borderRadius: '5px',
        border: `1px solid ${tokens.colorNeutralStroke2}`,
        padding: '6px 8px',
        maxHeight: '140px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
    },
    logLine: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '6px',
        fontSize: '11px',
        fontFamily: tokens.fontFamilyMonospace ?? 'monospace',
        color: tokens.colorNeutralForeground2,
        lineHeight: '1.5',
    },
    logLineCurrent: {
        color: tokens.colorPaletteBlueForeground2,
        fontWeight: '600',
    },
    logDot: {
        flexShrink: 0,
        marginTop: '1px',
        width: '12px',
        textAlign: 'center',
    },
    toggleBtn: {
        background: 'none',
        border: 'none',
        padding: '0',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '3px',
        marginTop: '3px',
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        ':hover': { color: tokens.colorNeutralForeground1 },
    },
    screenshot: {
        width: '100%',
        maxHeight: '120px',
        objectFit: 'contain',
        borderRadius: '4px',
        marginTop: '4px',
        background: tokens.colorNeutralBackground3,
        cursor: 'pointer',
    },
});

function StatusIcon({ status }: { status: StepRunStatus }) {
    if (status === 'done') return <CheckmarkCircle16Filled color={tokens.colorPaletteGreenForeground1} />;
    if (status === 'failed') return <ErrorCircle16Filled color={tokens.colorPaletteRedForeground1} />;
    if (status === 'skipped') return <DismissCircle16Filled color={tokens.colorNeutralForeground3} />;
    if (status === 'running') return <ArrowSync16Regular style={{ animation: 'spin 1s linear infinite' }} />;
    if (status === 'agent_recovery') return <Sparkle16Regular color={tokens.colorPaletteBlueForeground2} />;
    if (status === 'awaiting_human_input' || status === 'awaiting_human_intervention') {
        return <Pause16Regular color={tokens.colorPaletteGoldForeground2} />;
    }
    if (status === 'verifying') return <ArrowSync16Regular />;
    return (
        <span style={{
            width: 14, height: 14, flexShrink: 0,
            border: `2px solid ${tokens.colorNeutralStroke2}`,
            borderRadius: '50%', display: 'inline-block',
        }} />
    );
}

export function StepRow({
    index,
    intent,
    tool,
    actor,
    classification,
    status,
    attemptCount,
    maxAuto,
    agentLogs,
    errorMessage,
    screenshot,
    observedUrl,
    agentModel,
    agentUsage,
}: StepRowProps) {
    const styles = useStyles();
    const [expanded, setExpanded] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);

    const isActive = status === 'running' || status === 'agent_recovery';
    const hasLogs = !!(agentLogs && agentLogs.length > 0);
    const hasDetails = hasLogs || !!errorMessage || !!screenshot;
    const showRetry = attemptCount > 0 && status !== 'done' && status !== 'skipped';

    // Auto-scroll log to bottom when new lines arrive
    useEffect(() => {
        if (isActive && logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [agentLogs, isActive]);

    // Auto-expand when step becomes active
    useEffect(() => {
        if (isActive) setExpanded(true);
    }, [isActive]);

    const showLog = hasLogs && (isActive || expanded);

    return (
        <div className={`${styles.row} ${isActive ? styles.rowActive : ''}`}>
            <span className={styles.index}>{index + 1}</span>
            <span className={styles.iconCol}>
                <StatusIcon status={status} />
            </span>
            <div className={styles.body}>
                <div className={styles.intentRow}>
                    <Text size={200} weight={isActive ? 'semibold' : 'regular'}>
                        {intent || tool}
                    </Text>
                    {showRetry && (
                        <span className={styles.retryBadge}>
                            retry {attemptCount}/{maxAuto}
                        </span>
                    )}
                    {(isActive || (hasLogs && status === 'done')) && actor === 'agent' && (
                        <span className={styles.agentBadge}>agent</span>
                    )}
                </div>

                <div className={styles.meta}>
                    <span className={styles.actorBadge} style={{ color: ACTOR_COLOR[actor] }}>
                        {ACTOR_ICON[actor]}
                        {actor}
                    </span>
                    <span>·</span>
                    <span style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '10px' }}>
                        {classification}
                    </span>
                    {agentModel && status === 'done' && (
                        <>
                            <span>·</span>
                            <span style={{ fontSize: '10px', color: tokens.colorPaletteBlueForeground2 }}>
                                {agentUsage ? `${agentUsage.totalTokens} tok` : agentModel}
                            </span>
                        </>
                    )}
                    {observedUrl && (
                        <>
                            <span>·</span>
                            <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {observedUrl}
                            </span>
                        </>
                    )}
                </div>

                {/* Error always shown inline */}
                {errorMessage && (
                    <Text className={styles.errorText}>{errorMessage}</Text>
                )}

                {/* Log toggle for completed steps */}
                {!isActive && hasDetails && (
                    <button className={styles.toggleBtn} onClick={() => setExpanded(e => !e)}>
                        {expanded ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
                        {expanded ? 'Hide log' : `Show log (${(agentLogs?.length ?? 0)} lines)`}
                    </button>
                )}

                {/* Action log — live when active, collapsible when done */}
                {showLog && (
                    <div className={styles.logArea} ref={logRef}>
                        {agentLogs!.map((line, i) => {
                            const isCurrent = isActive && i === agentLogs!.length - 1;
                            return (
                                <div
                                    key={i}
                                    className={`${styles.logLine} ${isCurrent ? styles.logLineCurrent : ''}`}
                                >
                                    <span className={styles.logDot}>
                                        {isCurrent ? '▶' : '✓'}
                                    </span>
                                    {line}
                                </div>
                            );
                        })}

                        {/* Agent usage summary at bottom of log */}
                        {!isActive && agentUsage && (
                            <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, fontSize: '10px', color: tokens.colorNeutralForeground3, display: 'flex', gap: 12 }}>
                                <span>{agentModel}</span>
                                <span>↑{agentUsage.promptTokens} ↓{agentUsage.completionTokens} ∑{agentUsage.totalTokens} tok</span>
                                <span>{(agentUsage.inferenceTimeMs / 1000).toFixed(1)}s</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Screenshot shown when expanded (non-active) */}
                {!isActive && expanded && screenshot && (
                    <img
                        src={`data:image/jpeg;base64,${screenshot}`}
                        alt="step state"
                        className={styles.screenshot}
                    />
                )}
            </div>
        </div>
    );
}
