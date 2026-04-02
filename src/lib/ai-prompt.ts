/**
 * AIPromptService — Geração dinâmica de prompts para testes A/B de criativos.
 *
 * Diferente de um catálogo de prompts estáticos, este service usa a IA (Gemini)
 * para gerar prompts contextualizados com base na imagem controle e no tipo de
 * variável que está sendo testada. Isso garante isolamento de variável real.
 */

import type { VariableType } from "./types";

// ── Variable Types Catalog ──
// Definições estáticas do que pode ser testado. O prompt em si é gerado dinamicamente.

export const VARIABLE_TYPES: VariableType[] = [
  {
    id: "headline",
    name: "Headline / Copy principal",
    description: "Texto principal sobreposto à imagem (título, chamada, promessa)",
    category: "copy",
    prompt_guidance: "Mantenha TODOS os elementos visuais idênticos (cores, layout, imagens, fontes). Altere APENAS o texto principal/headline da imagem. O novo headline deve comunicar o mesmo benefício com abordagem diferente.",
    examples: ["Transforme sua carreira → Domine medicina capilar", "Faturamento 6 dígitos → Destaque-se na área"],
  },
  {
    id: "color_palette",
    name: "Paleta de cores",
    description: "Esquema de cores dominante (fundo, elementos, acentos)",
    category: "visual",
    prompt_guidance: "Mantenha TODOS os elementos iguais (layout, textos, imagens, fontes). Altere APENAS a paleta de cores. Substitua as cores dominantes por uma paleta completamente diferente mas que mantenha contraste e legibilidade.",
    examples: ["Azul escuro → Dourado quente", "Verde médico → Roxo premium"],
  },
  {
    id: "layout",
    name: "Layout / Composição",
    description: "Distribuição e posicionamento dos elementos na imagem",
    category: "layout",
    prompt_guidance: "Mantenha TODOS os textos, cores e imagens idênticos. Altere APENAS o layout/composição: posição dos elementos, alinhamento, proporção entre texto e imagem, uso do espaço.",
    examples: ["Centralizado → Lateral esquerdo", "Texto sobre imagem → Texto em banner separado"],
  },
  {
    id: "hero_image",
    name: "Imagem hero / Foto principal",
    description: "A foto ou imagem principal que ancora o criativo",
    category: "visual",
    prompt_guidance: "Mantenha TODOS os textos, cores, layout e elementos gráficos. Altere APENAS a foto/imagem principal. Use uma foto diferente que comunique o mesmo conceito mas com enquadramento ou contexto diferente.",
    examples: ["Foto de rosto → Foto em consultório", "Produto isolado → Produto em uso"],
  },
  {
    id: "cta_style",
    name: "Estilo do CTA (botão/chamada)",
    description: "Aparência e texto do call-to-action visual no criativo",
    category: "copy",
    prompt_guidance: "Mantenha TODOS os elementos visuais e textos principais. Altere APENAS o botão/CTA: cor, formato, texto, posição, estilo (arredondado, retangular, com ícone, etc).",
    examples: ["Botão verde → Seta laranja", "SAIBA MAIS → QUERO PARTICIPAR"],
  },
  {
    id: "social_proof",
    name: "Prova social / Autoridade",
    description: "Elementos de credibilidade: números, depoimentos, logos, selos",
    category: "copy",
    prompt_guidance: "Mantenha o layout e cores base. Adicione ou modifique APENAS elementos de prova social: números de alunos, depoimento curto, selo de garantia, logo de parceiros, resultado comprovado.",
    examples: ["+2.000 alunos", "97% de aprovação", "Selo de garantia 7 dias"],
  },
  {
    id: "visual_style",
    name: "Estilo visual / Tratamento",
    description: "Tratamento visual geral: fotográfico, ilustrado, minimalista, premium",
    category: "visual",
    prompt_guidance: "Mantenha textos e mensagem idênticos. Altere o tratamento visual geral: pode ser mais fotográfico vs. ilustrado, minimalista vs. rico, profissional vs. casual, moderno vs. clássico.",
    examples: ["Fotográfico → Flat design", "Minimalista → Rich media"],
  },
  {
    id: "format_orientation",
    name: "Enquadramento / Orientação",
    description: "Proporção e orientação do conteúdo dentro do formato",
    category: "format",
    prompt_guidance: "Mantenha todos os elementos. Altere como o conteúdo é enquadrado: zoom in vs. zoom out, foco central vs. regra dos terços, margem ampla vs. full bleed.",
    examples: ["Close-up → Plano aberto", "Centralizado → Terços"],
  },
];

// ── Prompt Generation ──

interface PromptGenerationInput {
  variableType: VariableType;
  variableValue?: string;
  controlDescription?: string;
  format: "feed" | "stories";
  additionalContext?: string;
}

/**
 * Gera o prompt para o Gemini criar uma variante com variável isolada.
 * O prompt é construído em camadas:
 * 1. Instrução base (manter fidelidade ao controle)
 * 2. Regra de isolamento da variável
 * 3. Guidance específico do tipo de variável
 * 4. Valor concreto da variação (se fornecido)
 * 5. Especificações técnicas do formato
 */
export function buildVariantPrompt(input: PromptGenerationInput): string {
  const { variableType, variableValue, controlDescription, format } = input;

  const dimensions = format === "feed"
    ? { w: 1080, h: 1080, aspect: "1:1" }
    : { w: 1080, h: 1920, aspect: "9:16" };

  const sections: string[] = [];

  // 1. Instrução base
  sections.push(
    `Você é um designer especialista em anúncios para Instagram/Facebook.`,
    `Sua tarefa: criar uma VARIANTE de um anúncio existente (a imagem de referência anexada).`,
    `A variante deve ser IDÊNTICA ao original em todos os aspectos EXCETO a variável sendo testada.`,
    `Isso é um teste A/B — o isolamento da variável é CRÍTICO para que o teste seja válido.`,
  );

  // 2. O que manter (tudo exceto a variável)
  const keepList = [
    "headline", "color_palette", "layout", "hero_image",
    "cta_style", "social_proof", "visual_style", "format_orientation",
  ].filter((v) => v !== variableType.id);

  sections.push(
    `\nMANTENHA IDÊNTICO ao original:`,
    ...keepList.map((v) => {
      const vt = VARIABLE_TYPES.find((t) => t.id === v);
      return `- ${vt?.name || v}`;
    }),
  );

  // 3. O que alterar
  sections.push(
    `\nALTERE APENAS: ${variableType.name}`,
    variableType.prompt_guidance,
  );

  // 4. Valor concreto (se especificado)
  if (variableValue) {
    sections.push(`\nVariação específica solicitada: ${variableValue}`);
  }

  // 5. Descrição do controle (se fornecida, para reforçar contexto)
  if (controlDescription) {
    sections.push(`\nDescrição do criativo original: ${controlDescription}`);
  }

  // 6. Contexto adicional
  if (input.additionalContext) {
    sections.push(`\nContexto adicional: ${input.additionalContext}`);
  }

  // 7. Especificações técnicas
  sections.push(
    `\nESPECIFICAÇÕES TÉCNICAS:`,
    `- Formato: ${format === "feed" ? "Feed (quadrado)" : "Stories (vertical)"}`,
    `- Dimensões alvo: ${dimensions.w}x${dimensions.h}px`,
    `- Proporção: ${dimensions.aspect}`,
    `- Gere a imagem completa, pronta para publicação`,
    `- Texto deve ser legível e sem erros de ortografia`,
    `- A imagem deve parecer profissional e publicável`,
  );

  return sections.join("\n");
}

/**
 * Gera par de prompts (Feed + Stories) para uma variante.
 */
export function buildVariantPromptPair(
  variableType: VariableType | string,
  variableValue?: string,
  controlDescription?: string,
  additionalContext?: string
): { feedPrompt: string; storiesPrompt: string } {
  const vt = typeof variableType === "string"
    ? VARIABLE_TYPES.find((v) => v.id === variableType) || VARIABLE_TYPES[0]
    : variableType;

  const feedPrompt = buildVariantPrompt({
    variableType: vt,
    variableValue,
    controlDescription,
    format: "feed",
    additionalContext,
  });

  const storiesPrompt = buildVariantPrompt({
    variableType: vt,
    variableValue,
    controlDescription,
    format: "stories",
    additionalContext,
  });

  return { feedPrompt, storiesPrompt };
}

/**
 * Busca um VariableType pelo ID.
 */
export function getVariableType(id: string): VariableType | undefined {
  return VARIABLE_TYPES.find((v) => v.id === id);
}

/**
 * Lista todos os tipos de variáveis disponíveis.
 */
export function listVariableTypes(): VariableType[] {
  return VARIABLE_TYPES;
}
