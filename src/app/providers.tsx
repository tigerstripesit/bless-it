'use client';

import * as React from 'react';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';

// Custom theme or override can be done here. 
// For now, standard webDarkTheme is professional enough.

import { ThemeProvider } from '../lib/ThemeContext';
import { ModelConfigProvider } from '../lib/ModelConfigContext';

export function Providers({ children }: { children: React.ReactNode }) {
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
    }, []);

    // Fluent UI uses JS to style, so SSR/Hydration can be tricky without SSR provider.
    // Since we are doing SPA (Tauri), we just wait for mount.
    if (!mounted) {
        return <div style={{ background: '#292929', height: '100vh' }} />;
    }

    return (
        <ModelConfigProvider>
            <ThemeProvider>
                {children}
            </ThemeProvider>
        </ModelConfigProvider>
    );
}
