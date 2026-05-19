import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions, makeStyles, tokens, Text, Button, Input, Select, Switch, Spinner, Badge } from '@fluentui/react-components';
import { Clock20Regular, Delete20Regular, Save20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import type { WorkflowSchedule } from '@/types/workflow-types';

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalM,
        minWidth: '420px',
    },
    row: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalM,
    },
    label: {
        width: '100px',
        flexShrink: 0,
    },
    input: {
        flex: 1,
    },
    presets: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: tokens.spacingHorizontalXS,
    },
    infoRow: {
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacingHorizontalS,
        padding: tokens.spacingVerticalS,
        background: tokens.colorNeutralBackground3,
        borderRadius: tokens.borderRadiusMedium,
    },
    error: {
        color: tokens.colorPaletteRedForeground1,
        fontSize: tokens.fontSizeBase200,
    },
    success: {
        color: tokens.colorPaletteGreenForeground1,
        fontSize: tokens.fontSizeBase200,
    },
});

interface Props {
    workflowSlug: string;
    workflowName: string;
    open: boolean;
    onClose: () => void;
}

const CRON_PRESETS = [
    { label: 'Every 15 min', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Daily midnight', value: '0 0 * * *' },
    { label: 'Daily 2am', value: '0 2 * * *' },
    { label: 'Weekly Sunday', value: '0 0 * * 0' },
    { label: 'Weekdays 8am', value: '0 8 * * 1-5' },
    { label: 'Monthly 1st', value: '0 0 1 * *' },
];

export function SchedulePanel({ workflowSlug, workflowName, open, onClose }: Props) {
    const styles = useStyles();
    const [schedule, setSchedule] = useState<WorkflowSchedule | null>(null);
    const [cronExpression, setCronExpression] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [variables, setVariables] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setMessage(null);
        try {
            const s = await invoke<WorkflowSchedule | null>('workflow_schedule_get', { workflowSlug });
            setSchedule(s);
            setCronExpression(s?.cronExpression ?? '');
            setEnabled(s?.enabled ?? true);
            setVariables(s?.variables ? JSON.stringify(s.variables, null, 2) : '');
        } catch (e) {
            setMessage({ type: 'error', text: `Failed to load schedule: ${e}` });
        }
        setLoading(false);
    }, [workflowSlug]);

    useEffect(() => {
        if (open) load();
    }, [open, load]);

    const handleSave = useCallback(async () => {
        if (!cronExpression.trim()) {
            setMessage({ type: 'error', text: 'Cron expression is required.' });
            return;
        }
        setSaving(true);
        setMessage(null);
        try {
            let parsedVars: Record<string, unknown> = {};
            if (variables.trim()) {
                try { parsedVars = JSON.parse(variables.trim()); }
                catch { setMessage({ type: 'error', text: 'Variables must be valid JSON.' }); setSaving(false); return; }
            }
            await invoke('workflow_schedule_set', {
                workflowSlug,
                cronExpression: cronExpression.trim(),
                variables: parsedVars,
            });
            if (!enabled) {
                await invoke('workflow_schedule_toggle', { workflowSlug, enabled: false });
            }
            setMessage({ type: 'success', text: 'Schedule saved.' });
            await load();
        } catch (e) {
            setMessage({ type: 'error', text: `${e}` });
        }
        setSaving(false);
    }, [workflowSlug, cronExpression, enabled, variables, load]);

    const handleDelete = useCallback(async () => {
        setSaving(true);
        setMessage(null);
        try {
            await invoke('workflow_schedule_delete', { workflowSlug });
            setSchedule(null);
            setCronExpression('');
            setEnabled(true);
            setVariables('');
            setMessage({ type: 'success', text: 'Schedule removed.' });
        } catch (e) {
            setMessage({ type: 'error', text: `${e}` });
        }
        setSaving(false);
    }, [workflowSlug]);

    const handleToggle = useCallback(async (newEnabled: boolean) => {
        setEnabled(newEnabled);
        if (schedule) {
            try {
                await invoke('workflow_schedule_toggle', { workflowSlug, enabled: newEnabled });
                await load();
            } catch { /* ignore */ }
        }
    }, [workflowSlug, schedule, load]);

    return (
        <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
            <DialogSurface>
                <DialogBody>
                    <DialogTitle>
                        <Clock20Regular style={{ verticalAlign: 'middle', marginRight: 8 }} />
                        Schedule: {workflowName}
                    </DialogTitle>
                    <DialogContent>
                        <div className={styles.container}>
                            {loading ? (
                                <Spinner label="Loading schedule…" size="small" />
                            ) : (
                                <>
                                    {schedule && (
                                        <div className={styles.infoRow}>
                                            <Badge appearance="filled" color={schedule.enabled ? 'brand' : 'severe'}>
                                                {schedule.enabled ? 'Active' : 'Disabled'}
                                            </Badge>
                                            {schedule.lastRunAt && (
                                                <Text size={200}>Last run: {new Date(schedule.lastRunAt).toLocaleString()}</Text>
                                            )}
                                            {schedule.nextRunAt && schedule.enabled && (
                                                <Text size={200}>Next run: {new Date(schedule.nextRunAt).toLocaleString()}</Text>
                                            )}
                                        </div>
                                    )}

                                    <div className={styles.row}>
                                        <Text className={styles.label} size={200}>Presets</Text>
                                        <div className={styles.presets}>
                                            {CRON_PRESETS.map(p => (
                                                <Button key={p.value} size="small" appearance={cronExpression === p.value ? 'primary' : 'subtle'}
                                                    onClick={() => setCronExpression(p.value)}>
                                                    {p.label}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>

                                    <div className={styles.row}>
                                        <Text className={styles.label} size={200}>Cron</Text>
                                        <Input className={styles.input} size="small"
                                            value={cronExpression}
                                            onChange={(_, d) => setCronExpression(d.value)}
                                            placeholder="0 2 * * *"
                                        />
                                    </div>

                                    <div className={styles.row}>
                                        <Text className={styles.label} size={200}>Enabled</Text>
                                        <Switch checked={enabled} onChange={(_, d) => handleToggle(d.checked as boolean)} />
                                    </div>

                                    {variables && (
                                        <div className={styles.row}>
                                            <Text className={styles.label} size={200}>Variables</Text>
                                            <Input className={styles.input} size="small"
                                                value={variables}
                                                onChange={(_, d) => setVariables(d.value)}
                                                placeholder='{"key": "value"}'
                                            />
                                        </div>
                                    )}

                                    {message && (
                                        <Text className={message.type === 'error' ? styles.error : styles.success}>
                                            {message.text}
                                        </Text>
                                    )}
                                </>
                            )}
                        </div>
                    </DialogContent>
                    <DialogActions>
                        <Button appearance="subtle" onClick={onClose} disabled={saving}>
                            <Dismiss20Regular /> Close
                        </Button>
                        {schedule && (
                            <Button appearance="subtle" icon={<Delete20Regular />} onClick={handleDelete} disabled={saving} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                Remove schedule
                            </Button>
                        )}
                        <Button appearance="primary" icon={saving ? <Spinner size="tiny" /> : <Save20Regular />} onClick={handleSave} disabled={saving || !cronExpression.trim()}>
                            {saving ? 'Saving…' : 'Save'}
                        </Button>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
}
