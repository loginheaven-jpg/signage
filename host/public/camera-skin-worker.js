// 사진마다 종료하는 워커. 추론 그래프·WASM 힙과 중간 버퍼를 편집 화면에 남기지 않는다.
self.onmessage = async ({ data: { bitmap, stage, faces } }) => {
  let model;
  try {
    const { OVAL, connectedSkin, skinMasks, smoothSkin } = await import('./camera-skin-core.mjs');
    const { FaceLandmarker, ImageSegmenter, FilesetResolver } = await import('./vendor/mediapipe/vision_bundle.mjs');
    const vision = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    if (stage === 'faces') {
      model = await FaceLandmarker.createFromOptions(vision, {
        canvas: new OffscreenCanvas(1, 1),
        baseOptions: { modelAssetPath: '/vendor/mediapipe/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numFaces: 8, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5
      });
      const points = model.detect(bitmap).faceLandmarks;
      model.close(); model = null; bitmap.close();
      self.postMessage({ faces: points }); return;
    }
    const w = bitmap.width, h = bitmap.height;
    model = await ImageSegmenter.createFromOptions(vision, {
      canvas: new OffscreenCanvas(1, 1),
      baseOptions: { modelAssetPath: '/vendor/mediapipe/selfie_multiclass_256x256.tflite', delegate: 'CPU' },
      runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false
    });
    const labels = model.getLabels();
    if (labels[2] !== 'body-skin' || labels[3] !== 'face-skin') throw new Error('Unexpected skin model labels');
    const regions = [];
    for (const face of faces) {
      const xs = OVAL.map(i => face[i].x * w), ys = OVAL.map(i => face[i].y * h);
      const fw = Math.max(...xs) - Math.min(...xs), fh = Math.max(...ys) - Math.min(...ys);
      const left = Math.max(0, Math.floor(Math.min(...xs) - fw * 0.3)), top = Math.max(0, Math.floor(Math.min(...ys) - fh * 0.3));
      const right = Math.min(w, Math.ceil(Math.max(...xs) + fw * 0.3)), bottom = Math.min(h, Math.ceil(Math.max(...ys) + fh * 0.95));
      const bounds = { x: left / w, y: top / h, width: (right - left) / w, height: (bottom - top) / h };
      const scale = Math.min(1, 384 / Math.max(right - left, bottom - top));
      const crop = new OffscreenCanvas(Math.max(1, Math.round((right - left) * scale)), Math.max(1, Math.round((bottom - top) * scale)));
      const ctx = crop.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, left, top, right - left, bottom - top, 0, 0, crop.width, crop.height);
      model.segment(crop, result => {
        const masks = result.confidenceMasks, width = masks[2].width, height = masks[2].height;
        const body = masks[2].getAsFloat32Array(), skin = masks[3].getAsFloat32Array(), probability = new Uint8Array(width * height);
        for (let p = 0; p < probability.length; p++) probability[p] = Math.round(Math.min(1, body[p] + skin[p]) * 255);
        if (crop.width !== width || crop.height !== height) {
          const guide = new OffscreenCanvas(width, height); guide.getContext('2d').drawImage(crop, 0, 0, width, height);
          regions.push({ bounds, width, height, probability: connectedSkin(probability, width, height, face, bounds), guide: guide.getContext('2d').getImageData(0, 0, width, height).data });
          guide.width = guide.height = 1;
        } else regions.push({ bounds, width, height, probability: connectedSkin(probability, width, height, face, bounds), guide: ctx.getImageData(0, 0, width, height).data });
      });
      crop.width = crop.height = 1;
    }
    model.close(); model = null;
    const canvas = new OffscreenCanvas(w, h), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const source = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 1;
    const { alpha, tone } = skinMasks(regions, faces, source, w, h);
    regions.length = 0;
    if (!tone.some(value => value > 128)) throw new Error('피부 영역을 확인하지 못했습니다. 원본으로 진행하거나 다른 사진을 사용해 주세요.');
    const faceWidth = Math.max(...faces.map(face => (Math.max(...OVAL.map(i => face[i].x)) - Math.min(...OVAL.map(i => face[i].x))) * w));
    const retouched = smoothSkin(source, alpha, w, h, faceWidth);
    self.postMessage({ source, retouched, alpha, tone }, [source.buffer, retouched.buffer, alpha.buffer, tone.buffer]);
  } catch (error) { self.postMessage({ error: error.message || 'Skin analysis failed' }); }
  finally { model?.close(); bitmap.close(); }
};
