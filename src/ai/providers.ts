import { createAzure } from '@ai-sdk/azure';
import { createOpenAI, type OpenAIProviderSettings } from '@ai-sdk/openai';
import { type LanguageModelV1 } from '@ai-sdk/provider';
import { getEncoding } from 'js-tiktoken';

import langfuse from './observability.js';
import { RecursiveCharacterTextSplitter } from './text-splitter.js';

interface CustomOpenAIProviderSettings extends OpenAIProviderSettings {
  baseURL?: string;
}

// Create OpenAI provider
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_ENDPOINT || 'https://api.openai.com/v1',
} as CustomOpenAIProviderSettings);

const azure = createAzure({
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
  apiVersion: process.env.OPENAI_API_VERSION,
});

const llm = azure;

const customModel = process.env.OPENAI_MODEL || 'o3-mini';

// Create model with Langfuse instrumentation
const baseModel = llm(customModel, {
  reasoningEffort: customModel.startsWith('o') ? 'medium' : undefined,
  structuredOutputs: true,
});

export const o3MiniModel = {
  ...baseModel,
  defaultObjectGenerationMode: 'json',
  async doGenerate(options) {
    const generation = langfuse.generation({
      name: 'LLM Generation',
      model: customModel,
      input: options,
      modelParameters: {
        reasoningEffort: customModel.startsWith('o') ? 'medium' : undefined,
        structuredOutputs: true,
      },
    });

    try {
      const result = await baseModel.doGenerate(options);
      generation.end({ output: result });
      return result;
    } catch (error) {
      generation.end({ metadata: { error: String(error) } });
      throw error;
    }
  },
} as LanguageModelV1;

const MinChunkSize = 140;
const encoder = getEncoding('o200k_base');

// trim prompt to maximum context size
export function trimPrompt(
  prompt: string,
  contextSize = Number(process.env.CONTEXT_SIZE) || 128_000,
) {
  if (!prompt) {
    return '';
  }

  const length = encoder.encode(prompt).length;
  if (length <= contextSize) {
    return prompt;
  }

  const overflowTokens = length - contextSize;
  // on average it's 3 characters per token, so multiply by 3 to get a rough estimate of the number of characters
  const chunkSize = prompt.length - overflowTokens * 3;
  if (chunkSize < MinChunkSize) {
    return prompt.slice(0, MinChunkSize);
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap: 0,
  });
  const trimmedPrompt = splitter.splitText(prompt)[0] ?? '';

  // last catch, there's a chance that the trimmed prompt is same length as the original prompt, due to how tokens are split & innerworkings of the splitter, handle this case by just doing a hard cut
  if (trimmedPrompt.length === prompt.length) {
    return trimPrompt(prompt.slice(0, chunkSize), contextSize);
  }

  // recursively trim until the prompt is within the context size
  return trimPrompt(trimmedPrompt, contextSize);
}
