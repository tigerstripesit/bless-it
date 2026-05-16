'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
    Switch,
    Text,
    Label,
    Divider,
    Button,
    Input,
    tokens,
} from '@fluentui/react-components';
import {
    FEATURE_FLAG_CHANGE_EVENT,
    FeatureFlag,
    featureFlags,
    getFeatureFlagDefault,
    isFeatureFlagOverridden,
    resetFeatureFlag,
    setFeatureFlag,
} from '@/lib/featureFlags';
import {
    RUNTIME_SETTING_CHANGE_EVENT,
    getRuntimeSettingBounds,
    getRuntimeSettingDefault,
    isRuntimeSettingOverridden,
    resetRuntimeSetting,
    runtimeSettings,
    setRuntimeSetting,
} from '@/lib/runtimeSettings';

interface FlagDescriptor {
    key: FeatureFlag;
    label: string;
    description: string;
}

const BROWSER_FLAGS: FlagDescriptor[] = [
    {
        key: 'browserAgent',
        label: 'Browser-use harness',
        description:
            'Let the agent drive a real Chromium browser via a Playwright sidecar — open, navigate, observe, click/type with risk-tiered approval, extract structured data, and replay recorded workflows. Requires a vision-capable model (mark the active saved provider as Supports vision). Adds a Browser and Workflows pane to the main workspace.',
    },
];

const MEMORY_FLAGS: FlagDescriptor[] = [
    {
        key: 'memorySlidingWindow',
        label: 'Token-budget windowing',
        description:
            'Trim conversation history to fit a token budget before each call. Prevents runaway prompt sizes on long chats.',
    },
    {
        key: 'memoryRunningSummary',
        label: 'Running conversation summary',
        description:
            'When a chat grows past the threshold, generate a synthesis of decisions and in-flight task state. Re-prepended on every subsequent turn so reopening an old chat lands with context loaded.',
    },
    {
        key: 'memoryUserProfile',
        label: 'User profile (cross-conversation facts)',
        description:
            'Extract durable facts about you (role, preferences, ongoing projects) and inject them into every new conversation. Stored in ~/.ittoolkit/user_profile.md — you can edit or delete it directly.',
    },
    {
        key: 'memoryCrossConversationSearch',
        label: 'Cross-conversation search tool',
        description:
            'Expose a search_conversations tool the model can call when you reference prior chats ("the script we wrote last week").',
    },
    {
        key: 'memoryForgetting',
        label: 'Forgetting policy',
        description:
            'Drop profile facts older than 90 days that were reinforced fewer than 2 times. Annotate summaries older than 30 days as potentially stale.',
    },
];

interface FlagRowProps {
    descriptor: FlagDescriptor;
    onToggle: (key: FeatureFlag, value: boolean) => void;
    onReset: (key: FeatureFlag) => void;
    value: boolean;
    overridden: boolean;
}

const FlagRow: React.FC<FlagRowProps> = ({ descriptor, onToggle, onReset, value, overridden }) => (
    <div
        style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '12px 0',
        }}
    >
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
            }}
        >
            <Label htmlFor={`flag-${descriptor.key}`} weight="semibold">
                {descriptor.label}
            </Label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {overridden && (
                    <Button
                        appearance="subtle"
                        size="small"
                        onClick={() => onReset(descriptor.key)}
                    >
                        Reset
                    </Button>
                )}
                <Switch
                    id={`flag-${descriptor.key}`}
                    checked={value}
                    onChange={(_, data) => onToggle(descriptor.key, data.checked)}
                />
            </div>
        </div>
        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            {descriptor.description}
        </Text>
        {overridden && (
            <Text size={100} style={{ color: tokens.colorNeutralForeground4 }}>
                Default: {String(getFeatureFlagDefault(descriptor.key))}
            </Text>
        )}
    </div>
);

const AgentSection: React.FC = () => {
    const [, force] = useState(0);
    useEffect(() => {
        const handler = () => force((n) => n + 1);
        window.addEventListener(RUNTIME_SETTING_CHANGE_EVENT, handler);
        return () => window.removeEventListener(RUNTIME_SETTING_CHANGE_EVENT, handler);
    }, []);

    const max = runtimeSettings.maxToolIterations;
    const bounds = getRuntimeSettingBounds('maxToolIterations');
    const defaultVal = getRuntimeSettingDefault('maxToolIterations');
    const overridden = isRuntimeSettingOverridden('maxToolIterations');

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div>
                <Text weight="semibold" size={400}>
                    Agent
                </Text>
                <Text
                    size={200}
                    block
                    style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}
                >
                    How the agent loops between thinking and tool execution.
                </Text>
            </div>
            <Divider style={{ margin: '8px 0' }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '12px 0' }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '12px',
                    }}
                >
                    <Label htmlFor="max-tool-iterations" weight="semibold">
                        Max tool iterations per turn
                    </Label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {overridden && (
                            <Button
                                appearance="subtle"
                                size="small"
                                onClick={() => resetRuntimeSetting('maxToolIterations')}
                            >
                                Reset
                            </Button>
                        )}
                        <Input
                            id="max-tool-iterations"
                            type="number"
                            value={String(max)}
                            min={bounds?.min}
                            max={bounds?.max}
                            onChange={(_, data) => {
                                const parsed = parseInt(data.value, 10);
                                if (!Number.isNaN(parsed)) {
                                    setRuntimeSetting('maxToolIterations', parsed);
                                }
                            }}
                            style={{ maxWidth: '100px' }}
                        />
                    </div>
                </div>
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                    Number of tool-call → execute → re-call cycles allowed in a single user turn before the agent gives up. Higher = more exploration steps allowed, but more cost. Typical agents use 15-50.
                </Text>
                {overridden && (
                    <Text size={100} style={{ color: tokens.colorNeutralForeground4 }}>
                        Default: {defaultVal} (allowed range: {bounds?.min}-{bounds?.max})
                    </Text>
                )}
            </div>
        </div>
    );
};

export const MemorySettingsSection: React.FC = () => {
    const [, forceRender] = useState(0);

    useEffect(() => {
        const handler = () => forceRender((n) => n + 1);
        window.addEventListener(FEATURE_FLAG_CHANGE_EVENT, handler);
        return () => window.removeEventListener(FEATURE_FLAG_CHANGE_EVENT, handler);
    }, []);

    const handleToggle = useCallback((key: FeatureFlag, value: boolean) => {
        setFeatureFlag(key, value);
    }, []);

    const handleReset = useCallback((key: FeatureFlag) => {
        resetFeatureFlag(key);
    }, []);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <AgentSection />

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div>
                    <Text weight="semibold" size={400}>
                        Browser &amp; Workflows
                    </Text>
                    <Text
                        size={200}
                        block
                        style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}
                    >
                        Web-driving capabilities. When enabled the agent can run Playwright actions
                        against admin consoles, KB pages, and status sites. Off by default — turn it
                        on alongside a vision-capable saved provider.
                    </Text>
                </div>
                <Divider style={{ margin: '8px 0' }} />
                {BROWSER_FLAGS.map((flag) => (
                    <React.Fragment key={flag.key}>
                        <FlagRow
                            descriptor={flag}
                            onToggle={handleToggle}
                            onReset={handleReset}
                            value={featureFlags[flag.key]}
                            overridden={isFeatureFlagOverridden(flag.key)}
                        />
                        <Divider />
                    </React.Fragment>
                ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div>
                    <Text weight="semibold" size={400}>
                        Memory
                    </Text>
                    <Text
                        size={200}
                        block
                        style={{ color: tokens.colorNeutralForeground3, marginTop: '4px' }}
                    >
                        What the agent remembers across this chat and across other chats. Toggle a
                        piece off if it misbehaves — the others keep working. Settings persist in
                        this browser only.
                    </Text>
                </div>
                <Divider style={{ margin: '8px 0' }} />
                {MEMORY_FLAGS.map((flag) => (
                    <React.Fragment key={flag.key}>
                        <FlagRow
                            descriptor={flag}
                            onToggle={handleToggle}
                            onReset={handleReset}
                            value={featureFlags[flag.key]}
                            overridden={isFeatureFlagOverridden(flag.key)}
                        />
                        <Divider />
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
};
