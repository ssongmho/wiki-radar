# 테스트용 축약본 — 실제 파일(WIKI/_raw-link/link_raw.py)과 같은 형식의 사전 리터럴만 둔다.
import re

LATIN_PERSON = {
    "Gildong Hong": "홍길동",
}

# 메일함 → 위키 페이지명 (이름이 다른 것만)
FOLDER_PAGE = {
    "해온": "해온정밀",
    "경영지원": "사내 조직",
    "사업부": "사내 조직",
}
# 링크하지 않는 메일함 (분류 미완·잡음·엔티티가 아닌 것)
FOLDER_SKIP = {"_미분류", "_노이즈-추정", "_노이즈", "_격리", "etc", "내 메모",
               "사내-보안알림"}

# VOC customer → 위키 페이지명 (이름이 다른 것만)
CUST_PAGE = {
    # 주석이 끼어 있어도 읽어야 한다
    "한결": "한결케미칼",
}

SYSTEM_PAGE = {
    "CMS(화학물질관리시스템)": "화학물질 관리시스템 (CMS)",
}


def main():
    pass
