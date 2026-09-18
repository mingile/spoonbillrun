# 옛 지도 사진 아카이브 (MVP)

옛 지도 이미지 위에 아카이브 사진 위치를 원형 썸네일 마커로 표시하고, 목록·상세 보기와 연동하는 단일 페이지입니다.

## 실행 방법

`fetch`로 JSON을 불러오므로 **브라우저에서 `file://`로 직접 열면 동작하지 않습니다.** 프로젝트 루트에서 로컬 HTTP 서버를 띄운 뒤 접속하세요.

```bash
# Node가 있을 때
npx serve .

# Python 3
python3 -m http.server 8080
```

브라우저에서 `http://localhost:3000`(serve 기본) 또는 `http://localhost:8080` 등으로 엽니다.

## 지도 이미지 교체

1. 새 지도 파일을 `assets/`에 넣습니다 (예: `assets/map.webp`).
2. `main.js` 상단의 `MAP_IMAGE_PATH`를 해당 경로로 바꿉니다 (예: `assets/map.webp`).
3. 이미지 크기는 코드에 넣지 않습니다. 로드 시 `naturalWidth` / `naturalHeight`로 bounds가 잡힙니다.

## 사진 데이터 교체

`data/photos.json`을 편집합니다. 각 항목의 `x`, `y`는 **지도 이미지 좌상단 기준 픽셀 좌표**입니다 (포토샵 등과 동일).

| 필드 | 설명 |
|------|------|
| `id` | 고유 ID |
| `title`, `date`, `caption` | 표시용 텍스트 |
| `x`, `y` | 마커 위치 (픽셀) |
| `thumb` | 마커·목록용 썸네일 URL |
| `src` | 상세 보기용 큰 이미지 URL |

## 좌표 찍기 (개발 모드)

URL에 `?dev=1`을 붙입니다.

```
http://localhost:3000/?dev=1
```

지도를 클릭하면 **이미지 좌표 `{ x, y }`**가 콘솔과 화면 왼쪽 아래에 표시됩니다. 그 값을 `photos.json`에 그대로 넣으면 마커가 해당 위치에 찍힙니다.

## 기술

- HTML / CSS / JavaScript (ES module)
- [Leaflet 1.9.4](https://leafletjs.com/) (`L.CRS.Simple` + `L.imageOverlay`)

설계 배경은 `DECISIONS.md`를 참고하세요.
