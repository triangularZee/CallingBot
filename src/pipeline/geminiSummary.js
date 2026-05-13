import fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';

function geminiClient() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini summaries');
  }
  return new GoogleGenAI({ apiKey: config.geminiApiKey });
}

function summaryPrompt({ title, note = '', transcriptText }) {
  return `
너는 한국어 금융/기업 실적 컨퍼런스콜 전문 애널리스트다.
아래 녹취록을 천천히 검토한 뒤, 사용자가 지정한 형식에 맞춰 한국어 요약을 작성하라.

중요 규칙:
- 녹취록에 있는 모든 Q&A를 빠짐없이 포함한다.
- "Qn)" 줄과 "An)" 줄 사이에는 반드시 줄바꿈을 둔다.
- Q&A를 합치거나 생략하지 않는다.
- 숫자, 회사명, 제품명, 기간, 가이던스는 가능한 한 원문에 충실하게 유지한다.
- 정보가 불명확하면 "확인 필요"라고 적고 추정하지 않는다.
- 출력은 Markdown 텍스트만 제공한다.
- 사용자 메모가 있으면 요약의 초점과 해석에 반영하되, 녹취록과 충돌하는 내용을 사실처럼 쓰지 않는다.

반드시 아래 구조를 따른다.

YYMMDD_회사명 [핵심 태그]

(1) 핵심 요약

(2) 핵심 요약

(3) Guidance 또는 전망
■ 세부 항목
■ 세부 항목

필요한 만큼 번호를 이어간다.

-

[Q&A]

Q1) 질문자 기관: 질문

A1) 답변

Q2) 질문자 기관: 질문

A2) 답변

모든 Q&A가 끝날 때까지 반복한다.

-

[Implication]

(1) 투자/산업적 함의 제목

■ 세부 해석
■ 세부 해석

(2) 투자/산업적 함의 제목

■ 세부 해석
■ 세부 해석

통화 제목: ${title}

사용자 메모:
${note || '(없음)'}

녹취록:
${transcriptText}
`.trim();
}

export async function summarizeWithGemini(transcriptText, { title = 'meeting', note = '' } = {}) {
  const ai = geminiClient();
  const response = await ai.models.generateContent({
    model: config.geminiModel,
    contents: summaryPrompt({ title, note, transcriptText })
  });

  const summary = response.text ?? '';
  const summaryPath = outputPath(title, 'gemini-summary.md');
  await fs.writeFile(summaryPath, summary, 'utf8');

  return {
    summary,
    summaryPath
  };
}
