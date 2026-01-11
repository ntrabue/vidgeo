// Vidgeo - Simple Video to GIF Editor

// State
let ffmpeg = null;
let ffmpegLoaded = false;
let FFmpeg = null;

// Simple fetchFile implementation (replaces @ffmpeg/util)
async function fetchFile(file) {
  if (file instanceof File) {
    return new Uint8Array(await file.arrayBuffer());
  } else if (typeof file === 'string') {
    const response = await fetch(file);
    return new Uint8Array(await response.arrayBuffer());
  }
  return file;
}
let videoFile = null;
let videoDuration = 0;
let segments = []; // Array of { start, end, deleted }
let selectedSegmentIndex = null;
let history = [];

// DOM Elements
const importSection = document.getElementById('importSection');
const editorSection = document.getElementById('editorSection');
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const videoPlayer = document.getElementById('videoPlayer');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.querySelector('.play-icon');
const pauseIcon = document.querySelector('.pause-icon');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const timeline = document.getElementById('timeline');
const segmentsContainer = document.getElementById('segments');
const playhead = document.getElementById('playhead');
const splitBtn = document.getElementById('splitBtn');
const deleteBtn = document.getElementById('deleteBtn');
const undoBtn = document.getElementById('undoBtn');
const exportBtn = document.getElementById('exportBtn');
const newVideoBtn = document.getElementById('newVideoBtn');
const gifWidth = document.getElementById('gifWidth');
const gifFps = document.getElementById('gifFps');
const progressOverlay = document.getElementById('progressOverlay');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');

// Initialize FFmpeg
async function initFFmpeg() {
  if (ffmpegLoaded) return;

  // Get FFmpeg from global scope (loaded via CDN)
  if (typeof FFmpegWASM !== 'undefined') {
    FFmpeg = FFmpegWASM.FFmpeg;
  } else if (typeof window.FFmpegWASM !== 'undefined') {
    FFmpeg = window.FFmpegWASM.FFmpeg;
  } else {
    throw new Error('FFmpeg library not loaded. Please check your internet connection and try again.');
  }

  ffmpeg = new FFmpeg();

  ffmpeg.on('progress', ({ progress }) => {
    const percent = Math.round(progress * 100);
    progressFill.style.width = `${percent}%`;
  });

  ffmpeg.on('log', ({ message }) => {
    console.log('FFmpeg:', message);
  });

  await ffmpeg.load({
    coreURL: '/ffmpeg-core.js',
    wasmURL: '/ffmpeg-core.wasm',
  });

  ffmpegLoaded = true;
}

// Format time as M:SS.s
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${mins}:${secs.padStart(4, '0')}`;
}

// File handling
function handleFile(file) {
  if (!file || !file.type.startsWith('video/')) {
    alert('Please select a valid video file');
    return;
  }

  videoFile = file;
  const url = URL.createObjectURL(file);
  videoPlayer.src = url;

  videoPlayer.onloadedmetadata = () => {
    videoDuration = videoPlayer.duration;
    durationEl.textContent = formatTime(videoDuration);

    // Initialize with single segment covering whole video
    segments = [{ start: 0, end: videoDuration, deleted: false }];
    selectedSegmentIndex = null;
    history = [];

    renderSegments();
    updateButtons();

    importSection.hidden = true;
    editorSection.hidden = false;
  };
}

// Drag and drop
dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

fileInput.addEventListener('change', (e) => {
  handleFile(e.target.files[0]);
});

// Video playback
playPauseBtn.addEventListener('click', togglePlayPause);

function togglePlayPause() {
  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
}

videoPlayer.addEventListener('play', () => {
  playIcon.hidden = true;
  pauseIcon.hidden = false;
});

videoPlayer.addEventListener('pause', () => {
  playIcon.hidden = false;
  pauseIcon.hidden = true;
});

videoPlayer.addEventListener('timeupdate', () => {
  currentTimeEl.textContent = formatTime(videoPlayer.currentTime);
  updatePlayhead();

  // Skip deleted segments during playback
  if (!videoPlayer.paused) {
    skipDeletedSegments();
  }
});

// Find which segment contains a given time
function getSegmentAtTime(time) {
  for (let i = 0; i < segments.length; i++) {
    if (time >= segments[i].start && time < segments[i].end) {
      return { segment: segments[i], index: i };
    }
  }
  return null;
}

// Find the next kept segment after a given time
function getNextKeptSegment(afterTime) {
  for (let i = 0; i < segments.length; i++) {
    if (!segments[i].deleted && segments[i].start >= afterTime) {
      return segments[i];
    }
  }
  return null;
}

// Find the kept segment at or before a given time
function getKeptSegmentAtOrBefore(time) {
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].deleted && segments[i].start <= time) {
      return segments[i];
    }
  }
  return null;
}

// Skip over deleted segments during playback
function skipDeletedSegments() {
  const current = getSegmentAtTime(videoPlayer.currentTime);
  if (current && current.segment.deleted) {
    // Find next non-deleted segment
    const next = getNextKeptSegment(current.segment.end);
    if (next) {
      videoPlayer.currentTime = next.start;
    } else {
      // No more kept segments, pause at end
      videoPlayer.pause();
      // Go to end of last kept segment
      const lastKept = segments.filter(s => !s.deleted).pop();
      if (lastKept) {
        videoPlayer.currentTime = lastKept.end - 0.01;
      }
    }
  }
}

// Seek to a valid (non-deleted) position
function seekToValidPosition(targetTime) {
  const current = getSegmentAtTime(targetTime);

  if (!current) {
    // Past end, go to end of last kept segment
    const lastKept = segments.filter(s => !s.deleted).pop();
    if (lastKept) {
      videoPlayer.currentTime = lastKept.end - 0.01;
    }
    return;
  }

  if (current.segment.deleted) {
    // Clicked on deleted segment - find nearest kept segment
    const next = getNextKeptSegment(targetTime);
    const prev = getKeptSegmentAtOrBefore(targetTime);

    if (next && prev) {
      // Go to whichever is closer
      const distToNext = next.start - targetTime;
      const distToPrev = targetTime - prev.end;
      videoPlayer.currentTime = distToNext < distToPrev ? next.start : prev.end - 0.01;
    } else if (next) {
      videoPlayer.currentTime = next.start;
    } else if (prev) {
      videoPlayer.currentTime = prev.end - 0.01;
    }
  } else {
    videoPlayer.currentTime = targetTime;
  }
}

function updatePlayhead() {
  const percent = (videoPlayer.currentTime / videoDuration) * 100;
  playhead.style.left = `${percent}%`;
}

// Step forward, skipping deleted segments
function stepForward(amount) {
  let newTime = videoPlayer.currentTime + amount;
  const current = getSegmentAtTime(videoPlayer.currentTime);

  if (current && !current.segment.deleted) {
    // If stepping would go past end of current kept segment
    if (newTime >= current.segment.end) {
      const next = getNextKeptSegment(current.segment.end);
      if (next) {
        // Jump to start of next kept segment + remainder
        const remainder = newTime - current.segment.end;
        newTime = next.start + remainder;
      } else {
        // No more segments, go to end
        newTime = current.segment.end - 0.01;
      }
    }
  }

  videoPlayer.currentTime = Math.min(videoDuration, newTime);
  skipDeletedSegments();
}

// Step backward, skipping deleted segments
function stepBackward(amount) {
  let newTime = videoPlayer.currentTime - amount;
  const current = getSegmentAtTime(videoPlayer.currentTime);

  if (current && !current.segment.deleted) {
    // If stepping would go before start of current kept segment
    if (newTime < current.segment.start) {
      const prev = getKeptSegmentAtOrBefore(current.segment.start - 0.01);
      if (prev) {
        // Jump to end of previous kept segment - remainder
        const remainder = current.segment.start - newTime;
        newTime = prev.end - remainder;
      } else {
        // No previous segments, stay at start
        newTime = current.segment.start;
      }
    }
  }

  videoPlayer.currentTime = Math.max(0, newTime);

  // If we landed in a deleted segment, find nearest kept
  const landed = getSegmentAtTime(videoPlayer.currentTime);
  if (landed && landed.segment.deleted) {
    const prev = getKeptSegmentAtOrBefore(videoPlayer.currentTime);
    if (prev) {
      videoPlayer.currentTime = prev.end - 0.01;
    } else {
      const next = getNextKeptSegment(0);
      if (next) {
        videoPlayer.currentTime = next.start;
      }
    }
  }
}

// Timeline click to seek
timeline.addEventListener('click', (e) => {
  const rect = timeline.getBoundingClientRect();
  const percent = (e.clientX - rect.left) / rect.width;
  const targetTime = percent * videoDuration;
  seekToValidPosition(targetTime);
});

// Render segments on timeline
function renderSegments() {
  segmentsContainer.innerHTML = '';

  segments.forEach((seg, i) => {
    const div = document.createElement('div');
    const widthPercent = ((seg.end - seg.start) / videoDuration) * 100;

    div.className = `segment ${seg.deleted ? 'deleted' : 'kept'}`;
    if (i === selectedSegmentIndex) div.classList.add('selected');

    div.style.width = `${widthPercent}%`;

    const label = document.createElement('span');
    label.className = 'segment-label';
    label.textContent = `${formatTime(seg.end - seg.start)}`;
    div.appendChild(label);

    div.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSegment(i);
    });

    segmentsContainer.appendChild(div);
  });
}

function selectSegment(index) {
  selectedSegmentIndex = index;
  renderSegments();
  updateButtons();

  // Seek to segment start
  if (segments[index]) {
    videoPlayer.currentTime = segments[index].start;
  }
}

function updateButtons() {
  const hasSelection = selectedSegmentIndex !== null;
  const segmentCount = segments.length;

  // Can delete if selected and more than one segment, or if segment is already deleted (to toggle)
  deleteBtn.disabled = !hasSelection;

  // Update delete button text based on segment state
  if (hasSelection && segments[selectedSegmentIndex]) {
    const isDeleted = segments[selectedSegmentIndex].deleted;
    deleteBtn.innerHTML = isDeleted ? `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Restore
    ` : `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
      Delete
    `;
    deleteBtn.classList.toggle('danger', !isDeleted);
  }

  undoBtn.disabled = history.length === 0;
}

// Save state for undo
function saveState() {
  history.push(JSON.stringify(segments));
  if (history.length > 50) history.shift(); // Limit history
  updateButtons();
}

// Split at current playhead position
function splitAtPlayhead() {
  const time = videoPlayer.currentTime;

  // Find which segment contains this time
  let segmentIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (time >= segments[i].start && time < segments[i].end) {
      segmentIndex = i;
      break;
    }
  }

  if (segmentIndex === -1) return;

  const seg = segments[segmentIndex];

  // Don't split if too close to edges (within 0.1s)
  if (time - seg.start < 0.1 || seg.end - time < 0.1) return;

  saveState();

  // Split the segment
  const newSegments = [
    { start: seg.start, end: time, deleted: seg.deleted },
    { start: time, end: seg.end, deleted: seg.deleted }
  ];

  segments.splice(segmentIndex, 1, ...newSegments);
  selectedSegmentIndex = segmentIndex + 1; // Select the new right segment

  renderSegments();
  updateButtons();
}

// Toggle delete on selected segment
function toggleDeleteSegment() {
  if (selectedSegmentIndex === null) return;

  saveState();

  segments[selectedSegmentIndex].deleted = !segments[selectedSegmentIndex].deleted;

  renderSegments();
  updateButtons();
}

// Undo last action
function undo() {
  if (history.length === 0) return;

  segments = JSON.parse(history.pop());
  selectedSegmentIndex = null;

  renderSegments();
  updateButtons();
}

splitBtn.addEventListener('click', splitAtPlayhead);
deleteBtn.addEventListener('click', toggleDeleteSegment);
undoBtn.addEventListener('click', undo);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (editorSection.hidden) return;

  // Ignore if typing in input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'KeyS':
      splitAtPlayhead();
      break;
    case 'Delete':
    case 'Backspace':
      if (selectedSegmentIndex !== null) {
        e.preventDefault();
        toggleDeleteSegment();
      }
      break;
    case 'KeyZ':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        undo();
      }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      stepBackward(e.shiftKey ? 1 : 0.1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      stepForward(e.shiftKey ? 1 : 0.1);
      break;
  }
});

// Export to GIF
async function exportGIF() {
  const keptSegments = segments.filter(s => !s.deleted);

  if (keptSegments.length === 0) {
    alert('No segments to export! At least one segment must be kept.');
    return;
  }

  // Calculate total duration
  const totalDuration = keptSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (totalDuration > 30) {
    if (!confirm(`The GIF will be ${totalDuration.toFixed(1)} seconds long, which may result in a large file. Continue?`)) {
      return;
    }
  }

  progressOverlay.hidden = false;
  progressText.textContent = 'Loading FFmpeg...';
  progressFill.style.width = '0%';

  try {
    await initFFmpeg();

    progressText.textContent = 'Reading video file...';

    // Write input file
    const inputData = await fetchFile(videoFile);
    await ffmpeg.writeFile('input.mp4', inputData);

    const width = parseInt(gifWidth.value);
    const fps = parseInt(gifFps.value);

    // Build filter complex for keeping only non-deleted segments
    progressText.textContent = 'Processing segments...';

    if (keptSegments.length === 1) {
      // Single segment - simple trim
      const seg = keptSegments[0];
      await ffmpeg.exec([
        '-ss', seg.start.toFixed(3),
        '-t', (seg.end - seg.start).toFixed(3),
        '-i', 'input.mp4',
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', '0',
        'output.gif'
      ]);
    } else {
      // Multiple segments - need to concat
      // First extract each segment as a separate file
      for (let i = 0; i < keptSegments.length; i++) {
        const seg = keptSegments[i];
        progressText.textContent = `Processing segment ${i + 1}/${keptSegments.length}...`;

        await ffmpeg.exec([
          '-ss', seg.start.toFixed(3),
          '-t', (seg.end - seg.start).toFixed(3),
          '-i', 'input.mp4',
          '-c', 'copy',
          '-avoid_negative_ts', '1',
          `seg${i}.mp4`
        ]);
      }

      // Create concat file
      let concatList = '';
      for (let i = 0; i < keptSegments.length; i++) {
        concatList += `file 'seg${i}.mp4'\n`;
      }
      await ffmpeg.writeFile('concat.txt', concatList);

      // Concat and convert to GIF
      progressText.textContent = 'Creating GIF...';

      await ffmpeg.exec([
        '-f', 'concat',
        '-safe', '0',
        '-i', 'concat.txt',
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
        '-loop', '0',
        'output.gif'
      ]);

      // Cleanup temp files
      for (let i = 0; i < keptSegments.length; i++) {
        await ffmpeg.deleteFile(`seg${i}.mp4`);
      }
      await ffmpeg.deleteFile('concat.txt');
    }

    progressText.textContent = 'Preparing download...';

    // Read output and trigger download
    const data = await ffmpeg.readFile('output.gif');
    const blob = new Blob([data.buffer], { type: 'image/gif' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `vidgeo-${Date.now()}.gif`;
    a.click();

    URL.revokeObjectURL(url);

    // Cleanup
    await ffmpeg.deleteFile('input.mp4');
    await ffmpeg.deleteFile('output.gif');

  } catch (err) {
    console.error('Export error:', err);
    alert('Export failed: ' + err.message);
  } finally {
    progressOverlay.hidden = true;
  }
}

exportBtn.addEventListener('click', exportGIF);

// Load new video
newVideoBtn.addEventListener('click', () => {
  videoPlayer.pause();
  videoPlayer.src = '';
  videoFile = null;
  segments = [];
  selectedSegmentIndex = null;
  history = [];

  editorSection.hidden = true;
  importSection.hidden = false;
  fileInput.value = '';
});

// Preload FFmpeg in background after page load (optional, for faster export later)
window.addEventListener('load', () => {
  setTimeout(() => {
    if (typeof FFmpegWASM !== 'undefined') {
      initFFmpeg().catch(err => console.log('FFmpeg preload skipped:', err.message));
    }
  }, 2000);
});
