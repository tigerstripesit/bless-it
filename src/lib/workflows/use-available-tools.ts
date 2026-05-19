import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface ToolInfo {
    name: string;
    description: string;
    category: string;
}

const CATEGORY_ORDER = ['Browser', 'System', 'Composition', 'Human'];

export function useAvailableTools() {
    const [tools, setTools] = useState<ToolInfo[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const schema = await invoke<{
                availableTools: Array<{ name: string; description: string; category: string }>;
            }>('get_workflow_schema');
            setTools((schema.availableTools ?? []).map(t => ({
                name: t.name,
                description: t.description,
                category: t.category || 'Other',
            })));
        } catch {
            setTools([
                { name: 'browser.open', description: 'Open a browser session', category: 'Browser' },
                { name: 'browser.navigate', description: 'Navigate to a URL', category: 'Browser' },
                { name: 'browser.observe', description: 'Capture page state', category: 'Browser' },
                { name: 'browser.act', description: 'Interact with an element', category: 'Browser' },
                { name: 'browser.extract', description: 'Extract text from element', category: 'Browser' },
                { name: 'browser.close', description: 'Close browser session', category: 'Browser' },
                { name: 'shell.exec', description: 'Execute a shell command', category: 'System' },
                { name: 'http.request', description: 'Make an HTTP request', category: 'System' },
                { name: 'workflow.run', description: 'Run another workflow', category: 'Composition' },
                { name: 'human.gate', description: 'Pause for human interaction', category: 'Human' },
                { name: 'agent.task', description: 'Delegate to AI', category: 'Human' },
            ]);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const toolsByCategory = CATEGORY_ORDER
        .map(cat => ({
            category: cat,
            tools: tools.filter(t => t.category === cat),
        }))
        .filter(g => g.tools.length > 0);

    return { tools, toolsByCategory, loading, reload: load };
}
