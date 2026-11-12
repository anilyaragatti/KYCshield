// Keep virtual-camera names together so additional vendor labels are easy to add.
const VIRTUAL_CAMERA_PATTERNS = [
  'OBS Virtual Camera',
  'OBS-Camera',
  'ManyCam',
  'Snap Camera',
  'XSplit',
  'vCam',
  'Virtual Camera',
  'Virtual Cam',
  'e2eSoft',
  'CamTwist',
  'Splitcam',
  'ChromaCam',
  'mmhmm',
  'NDI Video',
  'Streamlabs',
  'YouCam',
  'Droidcam OBS'
];

function isVirtualCamera(label) {
  try {
    if (typeof label !== 'string' || !label.trim()) return { flagged: false, matched: null };
    const normalizedLabel = label.toLocaleLowerCase();
    const matched = VIRTUAL_CAMERA_PATTERNS.find((pattern) => normalizedLabel.includes(pattern.toLocaleLowerCase()));
    return { flagged: Boolean(matched), matched: matched || null };
  } catch (_error) {
    return { flagged: false, matched: null };
  }
}

module.exports = { isVirtualCamera };
