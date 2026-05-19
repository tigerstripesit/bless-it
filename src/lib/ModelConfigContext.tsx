'use client';

import React, { createContext, useContext, useState } from 'react';
import type { ModelConfig } from '@/types/ai-types';

interface ModelConfigContextValue {
    modelConfig: ModelConfig | null;
    setModelConfig: (config: ModelConfig | null) => void;
}

const ModelConfigContext = createContext<ModelConfigContextValue>({
    modelConfig: null,
    setModelConfig: () => {},
});

export function ModelConfigProvider({ children }: { children: React.ReactNode }) {
    const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
    return (
        <ModelConfigContext.Provider value={{ modelConfig, setModelConfig }}>
            {children}
        </ModelConfigContext.Provider>
    );
}

export function useModelConfig() {
    return useContext(ModelConfigContext);
}
