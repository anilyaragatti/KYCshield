window.KYCVirtualCam = (() => {
  async function listVideoInputs() {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return [];
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter((device) => device.kind === 'videoinput')
        .map((device) => ({ deviceId: device.deviceId, label: device.label || 'Camera' }));
    } catch (_error) {
      return [];
    }
  }

  function activeTrackLabel(track) {
    try {
      return typeof track?.label === 'string' ? track.label.trim() : '';
    } catch (_error) {
      return '';
    }
  }

  return { listVideoInputs, activeTrackLabel };
})();
