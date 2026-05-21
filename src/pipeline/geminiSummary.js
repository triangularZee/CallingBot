import fs from 'node:fs/promises';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { outputPath } from '../utils/files.js';
import { normalizeSummaryFormatting } from '../utils/summaryFormat.js';

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

function exampleStyleSummaryPrompt({ title, note = '', transcriptText }) {
  return `
너는 한국어 금융/기업 실적 컨퍼런스콜 전문 애널리스트다.
아래 녹취록을 천천히 검토한 뒤 사용자가 제공한 [Example]과 같은 애널리스트 노트 형식으로 한국어 요약을 작성하라.
출력은 Telegram으로 바로 전송될 plain Markdown 텍스트만 제공한다. 코드블록, \`\`\`markdown, \`\`\` 감싸기를 절대 쓰지 않는다.

중요 규칙:
- 첫 줄은 반드시 "YYMMDD_회사명 [핵심태그]" 형식으로 쓴다. 입력 title에 날짜/회사명이 있으면 그대로 활용한다.
- 대괄호 안 핵심태그는 3~6개로 압축한다. 실적 발표라면 Beat/Miss, 시가총액, 밸류에이션 등을 녹취록에 있을 때만 넣고, 없으면 사업/제품 키워드를 넣는다.
- 본문 앞부분은 (1), (2), (3)처럼 번호 항목으로 작성한다. 절대 "(1) 핵심 요약"처럼 같은 제목을 반복하지 않는다.
- 각 번호 항목은 예시처럼 바로 핵심 문장을 쓴다. 문단은 짧고 밀도 있게 작성한다.
- Guidance, 전망, 생산능력, CAPEX, 실적 가이던스가 있으면 별도 번호 항목으로 "Guidance 또는 전망"을 만들고, 하위 항목은 ■ 로 정리한다.
- Q&A는 녹취록에 있는 모든 질문과 답변을 빠짐없이 포함한다. Q&A를 합치거나 생략하지 않는다.
- 전체 문체는 개조식으로 쓴다. "~다", "~습니다", "~했다", "~있다" 같은 서술형 종결을 피하고, "확대", "전망", "수준", "진행 중", "가능성", "필요"처럼 끊는다.
- Q&A 답변도 반드시 개조식으로 쓴다. "답변했다/설명했다/전망했다"처럼 풀어 쓰지 말고 핵심만 압축한다.
- Q&A 형식은 정확히 "Q1) 기관/질문자: 질문" 다음 줄에 "A1) 답변"으로 쓴다. Q와 A 사이에 빈 줄을 넣지 않는다.
- 질문 기관/이름이 명확하지 않으면 "질문자"라고만 쓰고, "질문자 기관" 같은 어색한 표현은 쓰지 않는다.
- 숫자, 회사명, 제품명, 기간, 가이던스는 가능한 한 원문에 충실하게 유지한다.
- 정보가 불명확하면 "확인 필요"라고 적고 추정하지 않는다.
- Implication은 예시처럼 짧고 날카롭게 작성한다. 각 항목은 보통 1~2문장으로 끝내고, 불필요한 ■ 하위 bullet을 남발하지 않는다.
- 사용자 메모가 있으면 요약의 초점과 해석에 반영하되, 녹취록과 충돌하는 내용을 사실처럼 쓰지 않는다.

[Example]

260521_FY1Q27 NVIDIA [Beat, $5.4tn, 20x]

(1) 컨센서스 대비 매출액 +3%, 영업이익 +3% 상회

(2) 2Q27(F) Guidance
■ Revenue $89.18bn ~ $92.82bn vs. $87.36bn
■ Adj. GPM 74.5% ~ 75.5% vs. 75.0%
■ Adj. OPEX $8.3bn vs. $7.93bn

(3) 경영진은 Blackwell/Rubin 매출이 장기적으로 $1tn에 이를 것이라는 자신감을 유지

-

[Q&A]

Q1) Morgan Stanley: 새로운 세그먼트 차이/구분이 무엇이며, 각각 어떤 시장을 의미하는지?
A1) 하이퍼스케일은 대형 클라우드 기업의 내부 AI 워크로드, 두 번째 세그먼트는 AI 네이티브/엔터프라이즈/산업/소버린 AI 시장

Q2) BofA: 에이전트형 AI에서 CPU 수요는 GPU를 잠식하는지?
A2) CPU 수요 증가는 GPU 대체가 아니라 AI 에이전트 확산에 따른 추가 수요

-

[Implication]

(1) NVIDIA 성장축은 하이퍼스케일러 CAPEX 중심에서 AI 인프라 전체 TAM 내 M/S 확대로 이동 중

(2) Vera CPU는 GPU를 잠식하는 제품이 아니라 NVIDIA의 TAM을 넓히는 추가 성장축

[Input]

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
    contents: exampleStyleSummaryPrompt({ title, note, transcriptText })
  });

  const summary = normalizeSummaryFormatting(response.text ?? '');
  const summaryPath = outputPath(title, 'gemini-summary.md');
  await fs.writeFile(summaryPath, summary, 'utf8');

  return {
    summary,
    summaryPath
  };
}
