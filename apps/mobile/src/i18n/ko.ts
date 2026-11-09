import type { MessageKey } from "./en.ts"

/** 한국어 카탈로그. 존댓말 해요체로 써요. */
export const ko: Record<MessageKey, string> = {
  "common.cancel": "취소",
  "common.close": "닫기",
  "common.continue": "계속",
  "common.openSettings": "설정 열기",

  "welcome.title": "ROBot에 오신 걸 환영해요",
  "welcome.body": "컴퓨터가 워크플로우를 실행해요. 이 휴대폰으로 컴퓨터에 연결해요.",
  "welcome.name.label": "이 휴대폰의 이름",
  "welcome.name.hint": "연결할 때 컴퓨터에 이 이름이 보여요.",
  "welcome.name.placeholder": "내 휴대폰",
  "welcome.localNetwork":
    "ROBot은 같은 네트워크에 있는 컴퓨터에 바로 연결해요. 휴대폰이 로컬 네트워크를 써도 되는지 물으면 허용해 주세요. 컴퓨터에 연결하려면 꼭 필요해요.",

  "pair.title": "컴퓨터 연결하기",
  "pair.scan.hint":
    "컴퓨터에서 설정 → 기기 → 기기 연결하기를 열어요. 그다음 카메라로 QR 코드를 스캔해 주세요.",
  "pair.typeInstead": "직접 입력하기",
  "pair.scanInstead": "QR 코드 스캔",
  "pair.camera.ask": "QR 코드를 읽으려면 카메라가 필요해요.",
  "pair.camera.allow": "카메라 허용",
  "pair.camera.denied":
    "카메라를 쓸 수 없어요. 시스템 설정에서 켜거나 주소와 코드를 직접 입력해 주세요.",
  "pair.address.label": "주소",
  "pair.address.placeholder": "192.168.1.4:47800",
  "pair.address.hint": "컴퓨터의 기기 연결하기 화면에 주소가 나와요.",
  "pair.code.label": "6자리 코드",
  "pair.code.placeholder": "123 456",
  "pair.submit": "연결하기",
  "pair.checking": "코드를 확인하고 있어요…",
  "pair.checking.hint": "휴대폰에서는 최대 30초 정도 걸릴 수 있어요.",
  "pair.waiting": "{name}에서 허용해 주기를 기다리고 있어요…",
  "pair.waiting.hint": "{name}에서 허용을 눌러 주세요.",
  "pair.vpn":
    "이 네트워크 밖에서도 쓰려면 휴대폰과 컴퓨터를 같은 VPN으로 연결해 주세요. 예를 들면 Tailscale이 있어요.",
  "pair.localNetwork":
    "휴대폰이 로컬 네트워크를 써도 되는지 물어볼 수 있어요. 허용해 주세요. 컴퓨터에 연결하려면 필요해요.",

  "error.wrong_code": "코드가 맞지 않아요. 컴퓨터에 나온 코드를 확인해 주세요.",
  "error.code_ended": "이 코드는 만료됐어요. 컴퓨터에서 새 코드를 만들어 주세요.",
  "error.unreachable":
    "컴퓨터에 연결할 수 없어요. 휴대폰과 컴퓨터가 같은 네트워크나 같은 VPN에 있는지 확인해 주세요.",
  "error.not_accepting":
    "컴퓨터가 연결을 받지 않아요. 컴퓨터에서 “다른 기기의 연결 허용”을 켜 주세요.",
  "error.same_device": "같은 기기예요. 컴퓨터와 연결해 주세요.",
  "error.denied": "컴퓨터가 이 휴대폰을 허용하지 않았어요.",
  "error.limit": "연결 한도를 채웠어요. 컴퓨터 한 대에는 기기 10대, 휴대폰 한 대에는 서버 10개까지예요.",
  "error.update_app.this": "이 휴대폰의 앱을 업데이트해 주세요.",
  "error.update_app.server": "컴퓨터의 앱을 업데이트해 주세요.",
  "error.invalid_link": "ROBot 연결용 QR 코드가 아니에요.",
  "error.invalid_address": "올바른 주소가 아니에요. 192.168.1.4:47800 같은 형태로 입력해 주세요.",
  "error.invalid_name": "이 휴대폰의 이름을 입력해 주세요.",
  "error.offline": "서버가 오프라인이에요.",
  "error.timeout": "서버가 제시간에 답하지 않았어요.",
  "error.not_allowed": "허용되지 않아요. 컴퓨터에서 열어 주세요.",
  "error.file_too_large": "{detail} 파일이 20MB보다 커요.",
  "error.too_many_files": "메시지 하나에 파일을 최대 10개까지 첨부할 수 있어요.",
  "error.file_unreadable": "{detail} 파일을 읽을 수 없어요.",
  "error.generic": "잘 되지 않았어요. ({code})",

  "servers.title": "서버",
  "servers.add": "서버 추가",
  "servers.empty.title": "아직 컴퓨터가 없어요",
  "servers.empty.body": "ROBot이 실행 중인 컴퓨터와 이 휴대폰을 연결해 주세요.",
  "servers.settings": "설정",
  "servers.pairAgain": "다시 연결",
  "servers.localNetwork":
    "이 네트워크의 컴퓨터에 연결되지 않나요? ROBot이 로컬 네트워크를 쓸 수 있는지 확인해 주세요. 설정 → 개인정보 보호 및 보안 → 로컬 네트워크에 있어요.",
  "servers.row": "{name}, {state}",

  "state.connecting": "연결 중…",
  "state.online": "온라인",
  "state.reconnecting": "다시 연결 중",
  "state.offline": "오프라인",
  "state.not_allowed": "{name}에서 이 기기를 삭제했어요.",
  "state.update_app.this": "이 휴대폰의 앱을 업데이트해 주세요.",
  "state.update_app.server": "{name}의 앱을 업데이트해 주세요.",

  "file.size.b": "{n}B",
  "file.size.kb": "{n}KB",
  "file.size.mb": "{n}MB",

  "settings.title": "설정",
  "settings.language": "언어",
  "settings.language.system": "시스템 설정 따르기",
  "settings.language.en": "English",
  "settings.language.ko": "한국어",
  "settings.theme": "테마",
  "settings.theme.system": "시스템",
  "settings.theme.dark": "다크",
  "settings.theme.light": "라이트",
  "settings.servers": "서버",
  "settings.servers.empty": "이 휴대폰과 연결한 컴퓨터가 없어요.",
  "settings.unpair": "연결 해제",
  "settings.unpair.title": "{name}과(와) 연결을 해제할까요?",
  "settings.unpair.body":
    "이 휴대폰에서 {name}을(를) 지우고 저장한 내용도 삭제해요. {name}에서 직접 삭제할 때까지는 그 컴퓨터의 목록에 이 휴대폰이 남아 있어요.",
  "settings.device": "이 휴대폰",
  "settings.device.hint": "컴퓨터에 이 이름이 보여요.",

  "server.soon": "이 컴퓨터의 워크플로우는 나중에 휴대폰에서 볼 수 있어요.",
}
