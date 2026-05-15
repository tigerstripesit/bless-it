'use client';

/**
 * AI Chat Component
 * 
 * Main chat interface for AI interactions.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
    Button,
    Input,
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
import { ChatMessage, MessageRole } from '@/types/ai-types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolCallDisplay } from './ToolCallDisplay';

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
        ...shorthands.gap('8px'),
        alignItems: 'center',
    },
    input: {
        flex: 1,
        backgroundColor: tokens.colorNeutralBackground1,
        color: tokens.colorNeutralForeground1,
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
        '&:focus': {
            ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1),
        },
        '& input': {
            color: tokens.colorNeutralForeground1,
            '&::placeholder': {
                color: tokens.colorNeutralForeground3,
            },
        },
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
    },
    streamingIndicator: {
        display: 'flex',
        ...shorthands.gap('4px'),
        alignItems: 'center',
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
}

export function AIChat({
    messages,
    onSendMessage,
    onStopGeneration,
    isLoading = false,
    isStreaming = false,
    placeholder = 'Ask about your files...',
    loadingStatus = 'Thinking...',
}: AIChatProps) {
    const styles = useStyles();
    const [inputValue, setInputValue] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = () => {
        if (inputValue.trim() && !isLoading) {
            onSendMessage(inputValue.trim());
            setInputValue('');
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const formatTimestamp = (timestamp: number) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    return (
        <div className={styles.container}>
            <div className={styles.messagesContainer}>
                {messages.length === 0 ? (
                    <div className={styles.emptyState}>
                        <Bot24Regular />
                        <Text>Start a conversation about your files</Text>
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
                                                <ToolCallDisplay key={idx} execution={execution} />
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
                <Input
                    className={styles.input}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={placeholder}
                    disabled={isLoading}
                />
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
        </div >
    );
}
