'use client';

import React, { useState } from 'react';
import { makeStyles, tokens, Text } from '@fluentui/react-components';
import {
    ChevronDown12Regular,
    ChevronUp12Regular,
    Sparkle16Regular,
    Person12Regular,
    Bot12Regular,
} from '@fluentui/react-icons';
import type { VariableSource } from '@/types/workflow-types';

interface VariableEntry {
    name: string;
    value: unknown;
    source?: VariableSource;
}

interface VariablesPanelProps {
    variables: VariableEntry[];
}

const SOURCE_ICON: Partial<Record<VariableSource, React.ReactNode>> = {
    conversation_context: <Sparkle16Regular />,
    human_input: <Person12Regular />,
    literal: <Bot12Regular />,
};

const useStyles = makeStyles({
    root: {
        borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 14px',
        cursor: 'pointer',
        userSelect: 'none',
        background: tokens.colorNeutralBackground2,
        ':hover': { background: tokens.colorNeutralBackground3 },
    },
    body: {
        padding: '6px 14px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
    },
    varRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '6px',
        fontSize: '12px',
    },
    varName: {
        color: tokens.colorNeutralForeground3,
        minWidth: '80px',
        fontFamily: 'monospace',
    },
    varValue: {
        flex: 1,
        color: tokens.colorNeutralForeground1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '280px',
    },
    varSource: {
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        color: tokens.colorNeutralForeground3,
        fontSize: '11px',
    },
    unresolved: {
        color: tokens.colorNeutralForeground3,
        fontStyle: 'italic',
    },
});

function formatValue(val: unknown): string {
    if (val === undefined || val === null) return '—';
    if (typeof val === 'string') return val.length > 60 ? val.slice(0, 60) + '…' : val;
    return JSON.stringify(val);
}

export function VariablesPanel({ variables }: VariablesPanelProps) {
    const styles = useStyles();
    const [open, setOpen] = useState(true);

    if (variables.length === 0) return null;

    return (
        <div className={styles.root}>
            <div className={styles.header} onClick={() => setOpen((o) => !o)}>
                {open ? <ChevronUp12Regular /> : <ChevronDown12Regular />}
                <Text size={200} weight="semibold">Variables ({variables.length})</Text>
            </div>
            {open && (
                <div className={styles.body}>
                    {variables.map((v) => (
                        <div key={v.name} className={styles.varRow}>
                            <span className={styles.varName}>{v.name}</span>
                            <span className={v.value === undefined ? styles.unresolved : styles.varValue}>
                                {formatValue(v.value)}
                            </span>
                            {v.source && SOURCE_ICON[v.source] && (
                                <span className={styles.varSource} title={v.source}>
                                    {SOURCE_ICON[v.source]}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
