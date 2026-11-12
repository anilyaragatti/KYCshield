window.KYCWebRTC = (() => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  function createCall({ localVideo, remoteVideo, onConnectionChange, onRemoteStream }) {
    let peerConnection = null;
    let localStream = null;
    let socket = null;
    let pendingCandidates = [];

    function createPeerConnection() {
      if (peerConnection && peerConnection.signalingState !== 'closed') return peerConnection;
      peerConnection = new RTCPeerConnection({ iceServers });
      peerConnection.onicecandidate = (event) => {
        if (event.candidate && socket?.connected) {
          socket.emit('ice', { candidate: event.candidate.toJSON() });
        }
      };
      peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0] || new MediaStream([event.track]);
        remoteVideo.srcObject = remoteStream;
        if (onRemoteStream) onRemoteStream(remoteStream);
      };
      peerConnection.onconnectionstatechange = () => {
        if (onConnectionChange) onConnectionChange(peerConnection.connectionState);
      };
      return peerConnection;
    }

    async function startMedia() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera and microphone access is unavailable here. Open this page in Chrome over HTTPS or localhost, then retry.');
      }
      try {
        if (!localStream) {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: { facingMode: 'user' }
          });
        }
      } catch (error) {
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          throw new Error('Camera or microphone permission was denied. Allow access in your browser settings, then retry.');
        }
        if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          throw new Error('No camera or microphone was found. Connect a device, then retry.');
        }
        if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
          throw new Error('Camera or microphone is already in use by another app. Close that app, then retry.');
        }
        throw new Error('Could not start your camera and microphone. Check your device settings, then retry.');
      }

      localVideo.srcObject = localStream;
      const connection = createPeerConnection();
      const existingTracks = new Set(connection.getSenders().map((sender) => sender.track).filter(Boolean));
      localStream.getTracks().forEach((track) => {
        if (!existingTracks.has(track)) connection.addTrack(track, localStream);
      });
      return localStream;
    }

    function setSocket(nextSocket) {
      socket = nextSocket;
    }

    async function replaceVideoTrack(newTrack) {
      if (!newTrack || newTrack.kind !== 'video') throw new Error('A video track is required to switch cameras.');
      if (!localStream) throw new Error('Start the camera before switching devices.');
      const oldTrack = localStream.getVideoTracks()[0] || null;
      const connection = createPeerConnection();
      const sender = connection.getSenders().find((item) => item.track?.kind === 'video');
      try {
        if (sender) await sender.replaceTrack(newTrack);
        else connection.addTrack(newTrack, localStream);
        if (oldTrack && oldTrack !== newTrack) {
          localStream.removeTrack(oldTrack);
          oldTrack.stop();
        }
        if (!localStream.getVideoTracks().includes(newTrack)) localStream.addTrack(newTrack);
        localVideo.srcObject = localStream;
        await localVideo.play().catch(() => {});
        return oldTrack;
      } catch (error) {
        try { newTrack.stop(); } catch (_stopError) { /* track already stopped */ }
        throw error;
      }
    }

    async function createOffer() {
      await startMedia();
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      if (socket?.connected) {
        socket.emit('offer', {
          sdp: { type: peerConnection.localDescription.type, sdp: peerConnection.localDescription.sdp }
        });
      }
    }

    async function handleOffer(payload) {
      if (!payload?.sdp) return;
      await startMedia();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (socket?.connected) {
        socket.emit('answer', {
          sdp: { type: peerConnection.localDescription.type, sdp: peerConnection.localDescription.sdp }
        });
      }
    }

    async function handleAnswer(payload) {
      if (!payload?.sdp || !peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushCandidates();
    }

    async function addIceCandidate(payload) {
      if (!payload?.candidate) return;
      if (!peerConnection || !peerConnection.remoteDescription) {
        pendingCandidates.push(payload.candidate);
        return;
      }
      await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
    }

    async function flushCandidates() {
      const candidates = pendingCandidates;
      pendingCandidates = [];
      for (const candidate of candidates) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    }

    async function getLatency() {
      if (!peerConnection) return null;
      try {
        const stats = await peerConnection.getStats();
        for (const report of stats.values()) {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime != null) {
            return Math.round(report.currentRoundTripTime * 1000);
          }
        }
      } catch (_error) {
        return null;
      }
      return null;
    }

    function cleanup() {
      if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
      }
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
      }
      localVideo.srcObject = null;
      remoteVideo.srcObject = null;
      pendingCandidates = [];
    }

    return {
      startMedia,
      setSocket,
      replaceVideoTrack,
      getVideoTrack: () => localStream?.getVideoTracks()[0] || null,
      createOffer,
      handleOffer,
      handleAnswer,
      addIceCandidate,
      getLatency,
      cleanup,
      hasMedia: () => Boolean(localStream),
      connectionState: () => peerConnection?.connectionState || 'new'
    };
  }

  return { createCall };
})();
