/**
 * AIPromptService — Geração dinâmica de prompts para testes A/B de criativos.
 *
 * v2: Prompt em formato JSON ultra-detalhado para o Gemini.
 * Motivação: prompts em texto corrido causavam erros de ortografia/gramática
 * nos textos gerados dentro das imagens. O formato JSON estruturado força
 * o modelo a tratar cada texto como dado literal, reduzindo erros.
 *
 * Convenção: chaves e instruções em inglês, conteúdo textual em pt-BR.
 */

import type { VariableType } from "./types";

// ── Variable Types Catalog ──

export const VARIABLE_TYPES: VariableType[] = [
  {
    id: "headline",
    name: "Headline / Copy principal",
    description: "Texto principal sobreposto à imagem (título, chamada, promessa)",
    category: "copy",
    prompt_guidance: "Keep ALL visual elements identical (colors, layout, images, fonts). Change ONLY the main text/headline in the image. The new headline must communicate the same benefit with a different approach.",
    examples: ["Transforme sua carreira → Domine medicina capilar", "Faturamento 6 dígitos → Destaque-se na área"],
  },
  {
    id: "color_palette",
    name: "Paleta de cores",
    description: "Esquema de cores dominante (fundo, elementos, acentos)",
    category: "visual",
    prompt_guidance: "Keep ALL elements identical (layout, texts, images, fonts). Change ONLY the color palette. Replace dominant colors with a completely different palette that maintains contrast and readability.",
    examples: ["Azul escuro → Dourado quente", "Verde médico → Roxo premium"],
  },
  {
    id: "layout",
    name: "Layout / Composição",
    description: "Distribuição e posicionamento dos elementos na imagem",
    category: "layout",
    prompt_guidance: "Keep ALL texts, colors, and images identical. Change ONLY the layout/composition: element positioning, alignment, text-to-image ratio, use of space.",
    examples: ["Centralizado → Lateral esquerdo", "Texto sobre imagem → Texto em banner separado"],
  },
  {
    id: "hero_image",
    name: "Imagem hero / Foto principal",
    description: "A foto ou imagem principal que ancora o criativo",
    category: "visual",
    prompt_guidance: "Keep ALL texts, colors, layout, and graphic elements. Change ONLY the main photo/image. Use a different photo that communicates the same concept but with different framing or context.",
    examples: ["Foto de rosto → Foto em consultório", "Produto isolado → Produto em uso"],
  },
  {
    id: "cta_style",
    name: "Estilo do CTA (botão/chamada)",
    description: "Aparência e texto do call-to-action visual no criativo",
    category: "copy",
    prompt_guidance: "Keep ALL visual elements and main texts. Change ONLY the CTA button: color, shape, text, position, style (rounded, rectangular, with icon, etc).",
    examples: ["Botão verde → Seta laranja", "SAIBA MAIS → QUERO PARTICIPAR"],
  },
  {
    id: "social_proof",
    name: "Prova social / Autoridade",
    description: "Elementos de credibilidade: números, depoimentos, logos, selos",
    category: "copy",
    prompt_guidance: "Keep the base layout and colors. Add or modify ONLY social proof elements: student numbers, short testimonial, guarantee badge, partner logos, proven results.",
    examples: ["+2.000 alunos", "97% de aprovação", "Selo de garantia 7 dias"],
  },
  {
    id: "visual_style",
    name: "Estilo visual / Tratamento",
    description: "Tratamento visual geral: fotográfico, ilustrado, minimalista, premium",
    category: "visual",
    prompt_guidance: "Keep texts and message identical. Change the overall visual treatment: photographic vs. illustrated, minimalist vs. rich, professional vs. casual, modern vs. classic.",
    examples: ["Fotográfico → Flat design", "Minimalista → Rich media"],
  },
  {
    id: "format_orientation",
    name: "Enquadramento / Orientação",
    description: "Proporção e orientação do conteúdo dentro do formato",
    category: "format",
    prompt_guidance: "Keep all elements. Change how content is framed: zoom in vs. zoom out, center focus vs. rule of thirds, wide margin vs. full bleed.",
    examples: ["Close-up → Plano aberto", "Centralizado → Terços"],
  },
];

// ── JSON Prompt Schema ──

/**
 * Estrutura JSON do prompt enviado ao Gemini.
 * Cada campo tem propósito claro — o modelo recebe um contrato estruturado.
 */
interface PromptJson {
  task: {
    role: string;
    objective: string;
    context: string;
  };
  reference_image: {
    description: string;
    relationship: string;
    consistency_rule?: string;
  };
  ab_test: {
    variable_being_tested: {
      id: string;
      name: string;
      category: string;
      instruction: string;
      requested_variation: string | null;
    };
    isolation_rule: string;
    elements_to_keep_identical: Array<{
      element: string;
      category: string;
      instruction: string;
    }>;
  };
  text_content: {
    language: string;
    critical_rule: string;
    texts_in_image: Array<{
      role: string;
      exact_text: string;
      notes: string;
    }>;
  };
  output_specs: {
    format: string;
    width: number;
    height: number;
    aspect_ratio: string;
    safe_zone: string;
    quality: string[];
  };
  control_description: string | null;
  additional_context: string | null;
}

// ── Prompt Generation ──

interface PromptGenerationInput {
  variableType: VariableType;
  variableValue?: string;
  controlDescription?: string;
  format: "feed" | "stories";
  additionalContext?: string;
  /** Textos exatos que existem no controle — evita erros de ortografia */
  controlTexts?: ControlTexts;
  /**
   * Para Stories: indica que há duas imagens de referência anexadas.
   * Imagem 1 = controle original. Imagem 2 = Feed gerado com a mesma variação.
   * Isso garante consistência visual (cores, estilo) entre Feed e Stories.
   */
  hasFeedReference?: boolean;
}

/**
 * Textos exatos extraídos do criativo controle.
 * Quando fornecidos, cada texto é listado literalmente no prompt JSON,
 * eliminando a necessidade do modelo "ler" da imagem de referência.
 */
export interface ControlTexts {
  headline: string;
  subtitle?: string;
  cta?: string;
  extra?: string[];
}

/**
 * Gera o prompt JSON ultra-detalhado para o Gemini.
 *
 * Retorna uma string com:
 * 1. Instrução curta em texto (pré-JSON) — define contexto para o modelo
 * 2. Bloco JSON completo com todas as especificações
 *
 * O formato JSON resolve o problema de erros de ortografia porque:
 * - Textos são dados literais em campos explícitos, não parte de prosa
 * - Regras ficam inequívocas e parseáveis
 * - O modelo trata o JSON como especificação, não como conversa
 */
export function buildVariantPrompt(input: PromptGenerationInput): string {
  const { variableType, variableValue, controlDescription, format } = input;

  const dimensions = format === "feed"
    ? { w: 1080, h: 1080, aspect: "1:1", formatName: "Feed (square)" }
    : { w: 1080, h: 1920, aspect: "9:16", formatName: "Stories (vertical)" };

  // Elementos que devem permanecer idênticos (tudo exceto a variável testada)
  const keepElements = VARIABLE_TYPES
    .filter((v) => v.id !== variableType.id)
    .map((v) => ({
      element: v.name,
      category: v.category,
      instruction: `Keep exactly as in the reference image. Do not modify.`,
    }));

  // ── Construir textos que devem aparecer na imagem ──
  // Quando temos controlTexts, listamos cada texto literalmente.
  // Isso evita que o modelo "leia" da referência e erre a ortografia.
  const textInstructions: PromptJson["text_content"]["texts_in_image"] = [];
  const { controlTexts } = input;

  if (controlTexts) {
    // Temos os textos exatos do controle — melhor cenário
    const isHeadlineTest = variableType.id === "headline" && variableValue;
    const isCtaTest = variableType.id === "cta_style" && variableValue;

    // Headline
    textInstructions.push({
      role: "headline",
      exact_text: isHeadlineTest ? variableValue! : controlTexts.headline,
      notes: isHeadlineTest
        ? "This is the NEW headline. Render EXACTLY as written — every letter, accent, space."
        : "Keep this headline EXACTLY as written. Do not rephrase or modify.",
    });

    // Subtitle
    if (controlTexts.subtitle) {
      textInstructions.push({
        role: "subtitle",
        exact_text: controlTexts.subtitle,
        notes: "Render this subtitle EXACTLY as written. Every accent and space must match.",
      });
    }

    // CTA
    if (controlTexts.cta) {
      textInstructions.push({
        role: "cta",
        exact_text: isCtaTest ? variableValue! : controlTexts.cta,
        notes: isCtaTest
          ? "This is the NEW CTA text. Render EXACTLY as written."
          : "Render this CTA EXACTLY as written. Do not change any letter.",
      });
    }

    // Extra texts
    if (controlTexts.extra) {
      for (const text of controlTexts.extra) {
        textInstructions.push({
          role: "extra",
          exact_text: text,
          notes: "Render EXACTLY as written.",
        });
      }
    }
  } else if (variableType.category === "copy" && variableValue) {
    // Sem controlTexts mas temos variação de copy
    textInstructions.push({
      role: "modified_text",
      exact_text: variableValue,
      notes: `This is the NEW text for the ${variableType.name}. Render this EXACTLY as written — every letter, accent, and space must match.`,
    });
    textInstructions.push({
      role: "preserved_texts",
      exact_text: "[copy all other texts from the reference image exactly as they appear]",
      notes: "All other text elements must be reproduced character-by-character from the reference image.",
    });
  } else {
    // Fallback: sem controlTexts, sem variação de copy
    textInstructions.push({
      role: "all_texts",
      exact_text: "[reproduce every text from the reference image exactly as it appears]",
      notes: "Copy every text element character-by-character from the reference image. Do NOT rephrase, translate, abbreviate, or correct any text. Portuguese accents (ã, ç, é, ê, ô, etc.) must be perfectly reproduced.",
    });
  }

  const promptJson: PromptJson = {
    task: {
      role: "Expert Instagram/Facebook ad designer specializing in A/B testing",
      objective: "Create a VARIANT of the reference image (attached) by modifying ONLY the specified variable while keeping everything else pixel-perfect identical.",
      context: "This is a controlled A/B test. Variable isolation is CRITICAL for test validity. The variant must look like it was made by the same designer, same day, same brief — only the tested element changes.",
    },
    reference_image: input.hasFeedReference
      ? {
          description: "TWO reference images are attached: (1) the original control creative, (2) the Feed variant (1:1) already generated with this same A/B variation applied.",
          relationship: "Image 1 (control): source of structure, texts, and base layout. Image 2 (Feed variant): defines the EXACT visual variation applied (colors, style, treatment). Your Stories output MUST use the SAME visual variation as Image 2, adapted to the 9:16 vertical format.",
          consistency_rule: "The Stories and Feed versions must look like siblings — same color palette, same visual style, same mood. A user scrolling from Feed to Stories must recognize they are the same campaign.",
        }
      : {
          description: controlDescription || "See attached image — this is the control creative to create a variant from.",
          relationship: "The attached image is the CONTROL. Your output must be a variant of this exact image.",
        },
    ab_test: {
      variable_being_tested: {
        id: variableType.id,
        name: variableType.name,
        category: variableType.category,
        instruction: variableType.prompt_guidance,
        requested_variation: variableValue || null,
      },
      isolation_rule: "ONLY the variable above may differ from the reference image. Every other visual element, text, color, position, font, and graphic must remain IDENTICAL to the reference.",
      elements_to_keep_identical: keepElements,
    },
    text_content: {
      language: "pt-BR (Brazilian Portuguese)",
      critical_rule: "ALL text in the output image MUST be in correct Brazilian Portuguese with proper spelling, accents (ã, ç, é, ê, ô, ú, etc.), and grammar. NEVER invent, rephrase, or approximate text. If copying from the reference, reproduce character-by-character. If creating new text, ensure perfect Portuguese orthography. Double-check every word before rendering.",
      texts_in_image: textInstructions,
    },
    output_specs: {
      format: dimensions.formatName,
      width: dimensions.w,
      height: dimensions.h,
      aspect_ratio: dimensions.aspect,
      safe_zone: format === "stories"
        ? "CRITICAL for Stories: Keep ALL text and important elements within a safe zone of 5% margin on ALL sides. No text may touch or be cut off at the edges. The vertical format is narrower — text lines must be shorter to fit within the safe area."
        : "Keep all text and important elements away from the edges with comfortable margins.",
      quality: [
        "Production-ready, publishable as-is",
        "All text must be sharp, legible, and correctly spelled",
        "Professional design quality matching the reference",
        "No artifacts, no blurry text, no cut-off elements",
        "ALL text must fit completely within the image — no cropping or overflow",
      ],
    },
    control_description: controlDescription || null,
    additional_context: input.additionalContext || null,
  };

  // Montar prompt final: instrução curta + JSON
  const preamble = [
    "You are generating an ad image variant for an A/B test.",
    "Below is a detailed JSON specification. Follow it precisely.",
    "CRITICAL: All text rendered in the image must be in perfect Brazilian Portuguese with correct spelling and accents.",
    "The reference image is attached — create a variant following the spec below.",
    "",
    "```json",
    JSON.stringify(promptJson, null, 2),
    "```",
  ].join("\n");

  return preamble;
}

/**
 * Gera par de prompts JSON (Feed + Stories) para uma variante.
 */
export function buildVariantPromptPair(
  variableType: VariableType | string,
  variableValue?: string,
  controlDescription?: string,
  additionalContext?: string,
  controlTexts?: ControlTexts
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
    controlTexts,
  });

  const storiesPrompt = buildVariantPrompt({
    variableType: vt,
    variableValue,
    controlDescription,
    format: "stories",
    additionalContext,
    controlTexts,
    hasFeedReference: true, // Feed gerado é passado como 2ª referência no pipeline
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
