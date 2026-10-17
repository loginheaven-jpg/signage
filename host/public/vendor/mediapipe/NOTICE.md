# MediaPipe 얼굴 특징점 탐지

- `@mediapipe/tasks-vision` 0.10.21: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.21.tgz
- 얼굴 모델 float16 v1: https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
- Copyright Google LLC. Apache License 2.0 (`LICENSE`).
- JS/WASM 및 모델은 같은 서버에서 제공한다. 사진과 추론 결과를 Google 등 외부 서버에 전송하지 않는다.
- 보정 도구를 처음 선택할 때만 모델과 실행 파일을 불러온다.
