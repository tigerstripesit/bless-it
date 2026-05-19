'use client';

/**
 * AI Chat Component
 * 
 * Main chat interface for AI interactions.
 */

import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    Button,
    Text,
    Spinner,
    makeStyles,
    tokens,
    shorthands,
} from '@fluentui/react-components';
import {
    Send24Regular,
    Bot24Regular,
    Person24Regular,
    Stop24Regular,
} from '@fluentui/react-icons';
import { ChatMessage, MessageRole, SkillManifest } from '@/types/ai-types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallDisplay } from './ToolCallDisplay';

function detectOSName(): string {
    if (typeof navigator === 'undefined') return 'your system';
    const ua = navigator.userAgent;
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/Windows NT 10/i.test(ua)) return 'Windows 10/11';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Ubuntu/i.test(ua)) return 'Ubuntu';
    if (/Fedora/i.test(ua)) return 'Fedora';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'your system';
}

/**
 * Pull a friendly first-name-ish display out of an OS username:
 *   "r_hasan"   -> "Hasan"   (first segment "r" is too short, take longer one)
 *   "john.doe"  -> "John"
 *   "alice"     -> "Alice"
 *   ""          -> "there"
 */
function prettifyUserName(raw: string | null): string {
    if (!raw) return 'there';
    const parts = raw.split(/[._\-\s]+/).filter(Boolean);
    if (parts.length === 0) return 'there';
    let chosen = parts[0];
    if (chosen.length < 2) {
        const longer = parts.find((p) => p.length >= 2);
        if (longer) chosen = longer;
    }
    if (!chosen) return 'there';
    return chosen.charAt(0).toUpperCase() + chosen.slice(1).toLowerCase();
}

const GREETINGS = (name: string, os: string): string[] => [
    `Hey ${name} — RoRo here. What's up?`,
    `${name}, RoRo at your service. What shall we tackle?`,
    `Hi ${name}. RoRo here, running on ${os} and ready to help.`,
    `Reporting in, ${name}. Stuck process? Weird log? Disk full?`,
    `RoRo on duty for ${name}. Where shall we start?`,
    `${name}! Good to see you. RoRo here on ${os}.`,
    `Welcome back, ${name}. RoRo's listening.`,
];

function pickGreeting(name: string): string {
    const os = detectOSName();
    const options = GREETINGS(name, os);
    return options[Math.floor(Math.random() * options.length)];
}

const useStyles = makeStyles({
    container: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: tokens.colorNeutralBackground1,
    },
    messagesContainer: {
        flex: 1,
        overflowY: 'auto',
        ...shorthands.padding('16px'),
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('12px'),
    },
    messageWrapper: {
        display: 'flex',
        ...shorthands.gap('8px'),
        alignItems: 'flex-start',
    },
    userMessage: {
        flexDirection: 'row-reverse',
    },
    messageIcon: {
        width: '32px',
        height: '32px',
        ...shorthands.borderRadius('50%'),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    userIcon: {
        backgroundColor: tokens.colorBrandBackground,
        color: tokens.colorNeutralForegroundOnBrand,
    },
    assistantIcon: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground1,
    },
    messageContent: {
        maxWidth: '85%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
    },
    messageBubble: {
        // maxWidth moved to messageContent
        ...shorthands.padding('12px', '16px'),
        ...shorthands.borderRadius('16px'),
        wordWrap: 'break-word',
        // whiteSpace: 'pre-wrap', // Removed to let markdown handle spacing
        lineHeight: '1.5',
        '& p': {
            margin: 0,
            marginBottom: '8px',
        },
        '& p:last-child': {
            marginBottom: 0,
        },
        '& ul, & ol': {
            marginTop: '4px',
            marginBottom: '8px',
            paddingLeft: '24px',
        },
        '& li': {
            marginBottom: '4px',
        },
        '& pre': {
            backgroundColor: tokens.colorNeutralBackground1, // Use a neutral background
            padding: '8px',
            borderRadius: '4px',
            overflowX: 'auto',
            marginTop: '8px',
            marginBottom: '8px',
            border: `1px solid ${tokens.colorNeutralStroke1}`,
        },
        '& code': {
            fontFamily: 'monospace',
            backgroundColor: 'rgba(0, 0, 0, 0.1)', // Subtle background for inline code
            padding: '2px 4px',
            borderRadius: '4px',
        },
        '& pre code': {
            backgroundColor: 'transparent', // Reset for code blocks
            padding: 0,
        },
        '& blockquote': {
            borderLeft: `3px solid ${tokens.colorNeutralStroke1}`,
            margin: '8px 0',
            paddingLeft: '12px',
            color: tokens.colorNeutralForeground2,
        },
        '& table': {
            borderCollapse: 'collapse',
            width: '100%',
            marginTop: '8px',
            marginBottom: '8px',
            fontSize: '13px',
            display: 'block',
            overflowX: 'auto',
            maxWidth: '100%',
        },
        '& th, & td': {
            border: `1px solid ${tokens.colorNeutralStroke1}`,
            padding: '6px 10px',
            textAlign: 'left',
            whiteSpace: 'nowrap',
        },
        '& th': {
            backgroundColor: tokens.colorNeutralBackground2,
            fontWeight: 600,
        },
    },
    userBubble: {
        backgroundColor: tokens.colorBrandBackground,
        color: tokens.colorNeutralForegroundOnBrand,
    },
    assistantBubble: {
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground1,
    },
    inputContainer: {
        ...shorthands.padding('16px'),
        backgroundColor: tokens.colorNeutralBackground2,
        ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke1),
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('4px'),
    },
    inputRow: {
        display: 'flex',
        ...shorthands.gap('8px'),
        alignItems: 'center',
    },
    prefillHint: {
        color: tokens.colorNeutralForeground3,
        paddingLeft: '2px',
    },
    inputShell: {
        position: 'relative',
        width: '100%',
        height: '32px',
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
        borderRadius: tokens.borderRadiusMedium,
        overflow: 'hidden',
        '&:focus-within': {
            ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1),
        },
    },
    // Invisible native <input> — captures focus, caret, and keyboard events.
    // Text color is transparent so the highlight layer renders on top.
    nativeInput: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        padding: '0 8px',
        margin: 0,
        fontFamily: tokens.fontFamilyBase,
        fontSize: tokens.fontSizeBase300,
        background: 'transparent',
        color: 'transparent',
        caretColor: tokens.colorNeutralForeground1,
        border: 'none',
        outline: 'none',
        '&::placeholder': {
            color: tokens.colorNeutralForeground3,
        },
        '&:disabled': {
            cursor: 'not-allowed',
        },
    },
    // Non-interactive overlay that renders highlighted spans over the native input.
    highlightLayer: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        fontFamily: tokens.fontFamilyBase,
        fontSize: tokens.fontSizeBase300,
        color: tokens.colorNeutralForeground1,
        whiteSpace: 'pre',
        overflow: 'hidden',
        pointerEvents: 'none',
        userSelect: 'none',
    },
    timestamp: {
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        marginTop: '4px',
    },
    emptyState: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        ...shorthands.gap('8px'),
        color: tokens.colorNeutralForeground3,
        textAlign: 'center',
        ...shorthands.padding('24px'),
    },
    emptyTitle: {
        display: 'block',
        textAlign: 'center',
        fontSize: '15px',
        fontWeight: 500,
        color: tokens.colorNeutralForeground1,
        maxWidth: '420px',
    },
    emptyHint: {
        display: 'block',
        textAlign: 'center',
        fontSize: '12px',
        color: tokens.colorNeutralForeground3,
        maxWidth: '420px',
    },
    streamingIndicator: {
        display: 'flex',
        ...shorthands.gap('4px'),
        alignItems: 'center',
    },
    inputWrapper: {
        position: 'relative',
        flex: 1,
    },
    palette: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 'calc(100% + 6px)',
        maxHeight: '280px',
        overflowY: 'auto',
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
        ...shorthands.borderRadius('8px'),
        boxShadow: tokens.shadow16,
        zIndex: 50,
        ...shorthands.padding('4px'),
    },
    paletteRow: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.padding('8px', '10px'),
        ...shorthands.borderRadius('6px'),
        cursor: 'pointer',
        ...shorthands.gap('2px'),
        ':hover': { backgroundColor: tokens.colorNeutralBackground3 },
    },
    paletteRowActive: {
        backgroundColor: tokens.colorNeutralBackground3,
    },
    paletteRowTop: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
    },
    paletteName: {
        fontFamily: tokens.fontFamilyMonospace,
        fontSize: '13px',
        fontWeight: 600,
        color: tokens.colorBrandForeground1,
    },
    paletteDesc: {
        fontSize: '12px',
        color: tokens.colorNeutralForeground2,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
    },
    paletteBadge: {
        fontSize: '10px',
        ...shorthands.padding('1px', '6px'),
        ...shorthands.borderRadius('10px'),
        backgroundColor: tokens.colorNeutralBackground3,
        color: tokens.colorNeutralForeground3,
    },
    paletteBadgeWarn: {
        backgroundColor: tokens.colorPaletteYellowBackground2,
        color: tokens.colorPaletteYellowForeground2,
    },
    paletteBadgeOk: {
        backgroundColor: tokens.colorPaletteGreenBackground2,
        color: tokens.colorPaletteGreenForeground2,
    },
    paletteFooter: {
        ...shorthands.padding('6px', '10px'),
        fontSize: '11px',
        color: tokens.colorNeutralForeground3,
        ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
        marginTop: '4px',
    },
    paletteEmpty: {
        ...shorthands.padding('12px'),
        fontSize: '12px',
        color: tokens.colorNeutralForeground3,
        textAlign: 'center',
    },
});

interface AIChatProps {
    messages: ChatMessage[];
    onSendMessage: (content: string) => void;
    onStopGeneration?: () => void;
    isLoading?: boolean;
    isStreaming?: boolean;
    placeholder?: string;
    loadingStatus?: React.ReactNode;
    skills?: SkillManifest[];
    /** Non-empty value pre-fills the chat input box. Used by "Ask Agent" to
     *  paste selected file paths so the user can type their intent. */
    prefillInput?: string;
    /** Callback when the user responds to an inline confirm_action card. */
    onActionResponse?: (actionId: string, response: 'confirm' | 'dismiss' | 'accept' | 'edit' | 'decline') => void;
}

export function AIChat({
    messages,
    onSendMessage,
    onStopGeneration,
    isLoading = false,
    isStreaming = false,
    placeholder = 'Ask about your files...',
    loadingStatus = 'Thinking...',
    skills = [],
    prefillInput,
    onActionResponse,
}: AIChatProps) {
    const styles = useStyles();
    const [inputValue, setInputValue] = useState('');

    // Consume prefillInput: when the prop gets a new non-empty value, set it as
    // the input value so the user can edit before sending.
    const consumedRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (prefillInput && prefillInput !== consumedRef.current) {
            consumedRef.current = prefillInput;
            setInputValue(prefillInput);
        }
    }, [prefillInput]);

    const [greeting, setGreeting] = useState<string>(() => pickGreeting('there'));
    const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
    const [paletteDismissed, setPaletteDismissed] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Palette is open when:
    //  - input starts with '/'
    //  - user hasn't pressed Escape since they last typed '/'
    //  - there's no space yet after the command name (once they're typing args,
    //    we stop showing the palette so Enter sends the message)
    const trimmed = inputValue.trimStart();
    const slashActive = trimmed.startsWith('/');
    const beforeSpace = slashActive ? trimmed.slice(1).split(/\s/)[0] : '';
    const hasArgsTyped = slashActive && /\s/.test(trimmed.slice(1));
    const filterQuery = beforeSpace.toLowerCase();
    const filteredSkills = slashActive && !hasArgsTyped
        ? skills.filter(
            (s) =>
                s.enabled &&
                s.userInvocable !== false &&
                s.name.toLowerCase().startsWith(filterQuery)
        )
        : [];
    const paletteOpen = slashActive && !paletteDismissed && !hasArgsTyped;

    useEffect(() => {
        setSelectedSkillIndex(0);
    }, [filterQuery, paletteOpen]);

    useEffect(() => {
        if (!slashActive) setPaletteDismissed(false);
    }, [slashActive]);

    useEffect(() => {
        let cancelled = false;
        invoke<string>('get_user_name')
            .then((raw) => {
                if (cancelled) return;
                setGreeting(pickGreeting(prettifyUserName(raw)));
            })
            .catch(() => {
                /* keep the fallback greeting */
            });
        return () => { cancelled = true; };
    }, []);

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = () => {
        if (inputValue.trim() && !isLoading) {
            onSendMessage(inputValue.trim());
            setInputValue('');
            setPaletteDismissed(false);
        }
    };

    const acceptSkillAt = (index: number) => {
        const skill = filteredSkills[index];
        if (!skill) return;
        // Replace the slash-command prefix with the full skill name + trailing space.
        const restOfInput = trimmed.slice(beforeSpace.length + 1); // everything after "/name"
        setInputValue(`/${skill.name} ${restOfInput.trimStart()}`);
        setPaletteDismissed(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (paletteOpen && filteredSkills.length > 0) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSkillIndex((i) => Math.min(i + 1, filteredSkills.length - 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSkillIndex((i) => Math.max(i - 1, 0));
                return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                acceptSkillAt(selectedSkillIndex);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setPaletteDismissed(true);
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const formatTimestamp = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    // Returns the highlight-layer content: /command in brand color, args in normal color.
    // When not in slash-command mode, the value is rendered as plain text (no coloring needed
    // since the overlay and native input share the same foreground token).
    const renderHighlight = (value: string): React.ReactNode => {
        if (!slashActive) return value;
        const trimmed = value.trimStart();
        const leadingSpace = value.slice(0, value.length - trimmed.length);
        const spaceIdx = trimmed.search(/\s/);
        const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
        return (
            <>
                {leadingSpace}
                <span style={{ color: tokens.colorBrandForeground1 }}>{command}</span>
                {rest}
            </>
        );
    };

    return (
        <div className={styles.container}>
            <div className={styles.messagesContainer}>
                {messages.length === 0 ? (
                    <div className={styles.emptyState}>
                        <Bot24Regular />
                        <Text className={styles.emptyTitle}>{greeting}</Text>
                        <Text className={styles.emptyHint}>
                            Ask anything, or type <code>/</code> to invoke a skill — try <code>/disk-cleanup</code> or <code>/network-diagnostics</code>.
                        </Text>
                    </div>
                ) : (
                    <>
                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`${styles.messageWrapper} ${message.role === MessageRole.User ? styles.userMessage : ''
                                    }`}
                            >
                                <div
                                    className={`${styles.messageIcon} ${message.role === MessageRole.User
                                        ? styles.userIcon
                                        : styles.assistantIcon
                                        }`}
                                >
                                    {message.role === MessageRole.User ? (
                                        <Person24Regular />
                                    ) : (
                                        <Bot24Regular />
                                    )}
                                </div>
                                <div className={styles.messageContent}>
                                    {/* Tool Executions (if any) */}
                                    {message.toolExecutions && message.toolExecutions.length > 0 && (
                                        <div style={{ marginBottom: '8px' }}>
                                            {message.toolExecutions.map((execution, idx) => (
                                                <ToolCallDisplay key={idx} execution={execution} onActionResponse={onActionResponse} />
                                            ))}
                                        </div>
                                    )}

                                    {/* Message Content */}
                                    {message.content && (
                                        <div
                                            className={`${styles.messageBubble} ${message.role === MessageRole.User
                                                ? styles.userBubble
                                                : styles.assistantBubble
                                                }`}
                                        >
                                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                                {message.content}
                                            </ReactMarkdown>
                                        </div>
                                    )}

                                    <div className={styles.timestamp}>
                                        {formatTimestamp(message.timestamp)}
                                    </div>
                                </div>
                            </div>
                        ))}
                        {isLoading && !isStreaming && (
                            <div className={styles.messageWrapper}>
                                <div className={`${styles.messageIcon} ${styles.assistantIcon}`}>
                                    <Bot24Regular />
                                </div>
                                <div className={styles.streamingIndicator}>
                                    <Spinner size="tiny" />
                                    <Text size={200}>{loadingStatus}</Text>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </>
                )}
            </div>

            <div className={styles.inputContainer}>
                <div className={styles.inputRow}>
                <div className={styles.inputWrapper}>
                    {paletteOpen && (
                        <div className={styles.palette} role="listbox" aria-label="Skill commands">
                            {filteredSkills.length === 0 ? (
                                <div className={styles.paletteEmpty}>
                                    No skills match <code>/{filterQuery}</code>. Press Escape to dismiss.
                                </div>
                            ) : (
                                <>
                                    {filteredSkills.map((skill, i) => {
                                        const isActive = i === selectedSkillIndex;
                                        return (
                                            <div
                                                key={skill.name}
                                                role="option"
                                                aria-selected={isActive}
                                                className={`${styles.paletteRow} ${isActive ? styles.paletteRowActive : ''}`}
                                                onMouseEnter={() => setSelectedSkillIndex(i)}
                                                onMouseDown={(e) => {
                                                    // mousedown (not click) so the input doesn't blur first
                                                    e.preventDefault();
                                                    acceptSkillAt(i);
                                                }}
                                            >
                                                <div className={styles.paletteRowTop}>
                                                    <span className={styles.paletteName}>/{skill.name}</span>
                                                    {skill.disableModelInvocation && (
                                                        <span className={styles.paletteBadge}>Manual only</span>
                                                    )}
                                                    {skill.hasShellInjection && (
                                                        <span
                                                            className={`${styles.paletteBadge} ${skill.trusted ? styles.paletteBadgeOk : styles.paletteBadgeWarn}`}
                                                        >
                                                            {skill.trusted ? 'Shell · trusted' : 'Shell · blocked'}
                                                        </span>
                                                    )}
                                                    {skill.argumentHint && (
                                                        <span className={styles.paletteBadge}>{skill.argumentHint}</span>
                                                    )}
                                                </div>
                                                <span className={styles.paletteDesc} title={skill.description}>
                                                    {skill.description || '(no description)'}
                                                </span>
                                            </div>
                                        );
                                    })}
                                    <div className={styles.paletteFooter}>
                                        ↑↓ navigate · Tab/Enter to accept · Esc to dismiss
                                    </div>
                                </>
                            )}
                        </div>
                    )}
                    <div className={styles.inputShell}>
                        <div className={styles.highlightLayer} aria-hidden="true">
                            {renderHighlight(inputValue)}
                        </div>
                        <input
                            className={styles.nativeInput}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={placeholder}
                            disabled={isLoading}
                        />
                    </div>
                </div>
                {isLoading && onStopGeneration ? (
                    <Button
                        appearance="primary"
                        icon={<Stop24Regular />}
                        onClick={onStopGeneration}
                        title="Stop generation"
                    />
                ) : (
                    <Button
                        appearance="primary"
                        icon={<Send24Regular />}
                        onClick={handleSend}
                        disabled={!inputValue.trim() || isLoading}
                    />
                )}
                </div>
                {prefillInput && inputValue === prefillInput && (
                    <Text className={styles.prefillHint} size={100}>
                        describe your task, or press ↵ Enter to start
                    </Text>
                )}
            </div>
        </div >
    );
}
