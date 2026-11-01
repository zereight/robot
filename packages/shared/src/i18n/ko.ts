import type { MessageKey } from "./en.ts"

/** Korean catalogue. Polite informal speech. */
export const ko: Record<MessageKey, string> = {
  "app.name": "ROBot",

  "settings.title": "설정",
  "settings.close": "설정 닫기",
  "settings.section.general": "일반",
  "settings.section.appearance": "화면",
  "settings.section.providers": "모델 제공자",
  "settings.section.devices": "기기",
  "settings.section.notifications": "알림",
  "settings.section.archive": "보관함",
  "settings.section.data": "데이터",
  "settings.section.about": "정보",
  "settings.later": "이 기능은 다음 버전에서 제공돼요.",

  "settings.language": "언어",
  "settings.language.system": "시스템 설정 따르기",
  "settings.language.en": "English",
  "settings.language.ko": "한국어",
  "settings.startAtLogin": "로그인할 때 시작",
  "settings.startAtLogin.hint": "이 컴퓨터에 로그인하면 ROBot을 열어요.",
  "settings.workspaceRoot": "에이전트 작업 폴더",
  "settings.workspaceRoot.hint": "새 에이전트의 폴더가 여기에 만들어져요.",
  "settings.workspaceRoot.change": "변경…",
  "settings.workspaceRoot.reset": "기본값 사용",

  "settings.theme": "테마",
  "settings.theme.system": "시스템 설정 따르기",
  "settings.theme.dark": "어둡게",
  "settings.theme.light": "밝게",
  "settings.textSize": "글자 크기",
  "settings.textSize.small": "작게",
  "settings.textSize.default": "기본",
  "settings.textSize.large": "크게",
  "settings.compactPlaces": "목록 좁게 보기",
  "settings.compactPlaces.hint": "행 높이를 줄여 더 많은 항목을 보여줘요.",
  "settings.reduceMotion": "움직임 줄이기",
  "settings.reduceMotion.system": "시스템 설정 따르기",
  "settings.reduceMotion.on": "켜기",
  "settings.reduceMotion.off": "끄기",

  "settings.data.folder": "데이터 폴더",
  "settings.data.folder.hint": "데이터베이스와 첨부 파일이 여기에 있어요.",
  "settings.data.open": "폴더 열기",

  "settings.about.version": "버전 {version}",
  "settings.about.licenses": "오픈 소스 라이선스",
  "settings.about.licenses.count": "패키지 {count}개",

  "home.title": "ROBot에 오신 걸 환영해요",
  "home.body": "여기에 에이전트가 표시돼요.",
  "home.openSettings": "설정 열기",
}
