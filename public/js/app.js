// Antigravity Kids Studio — Enterprise Video Production Dashboard

document.addEventListener('DOMContentLoaded', () => {
  // Global State
  let allStories = [];
  let currentFilter = 'all';
  let activeModalStory = null;
  let activeModalLang = 'en';
  let nextRunCountdownSeconds = 0;
  let countdownInterval = null;
  let elapsedSeconds = 0;
  let elapsedInterval = null;
  let isExecuting = false;

  // DOM Elements - Status Header
  const statusAgy = document.getElementById('status-agy');
  const statusFfmpeg = document.getElementById('status-ffmpeg');
  const statusElevenlabs = document.getElementById('status-elevenlabs');
  const statusDb = document.getElementById('status-db');
  const statusYt = document.getElementById('status-yt');
  const btnRefreshAll = document.getElementById('btn-refresh-all');

  // KPI Cards
  const kpiTotalStories = document.getElementById('kpi-total-stories');
  const kpiLatestTitle = document.getElementById('kpi-latest-title');
  const kpiTotalVideos = document.getElementById('kpi-total-videos');
  const kpiVideosDetail = document.getElementById('kpi-videos-detail');
  const kpiYoutubeStatus = document.getElementById('kpi-youtube-status');
  const kpiYoutubeDetail = document.getElementById('kpi-youtube-detail');
  const kpiScheduleLabel = document.getElementById('kpi-schedule-label');
  const kpiScheduleNext = document.getElementById('kpi-schedule-next');

  // Activity Center ("Happening NOW & LATER")
  const activityBeacon = document.getElementById('activity-beacon');
  const activityBeaconText = document.getElementById('activity-beacon-text');
  const activityElapsedBadge = document.getElementById('activity-elapsed-badge');
  const activityElapsedTime = document.getElementById('activity-elapsed-time');
  const stepperProgressFill = document.getElementById('stepper-progress-fill');
  const activityCurrentLabel = document.getElementById('activity-current-label');
  const activityDetailMsg = document.getElementById('activity-detail-msg');
  const upcomingTaskDesc = document.getElementById('upcoming-task-desc');
  const upcomingCountdownText = document.getElementById('upcoming-countdown-text');
  const btnMasterRunPipeline = document.getElementById('btn-master-run-pipeline');
  const btnToggleCustomTopic = document.getElementById('btn-toggle-custom-topic');
  const customTopicDrawer = document.getElementById('custom-topic-drawer');
  const inputCustomTopic = document.getElementById('input-custom-topic');
  const btnSubmitCustomPipeline = document.getElementById('btn-submit-custom-pipeline');

  // Stage nodes
  const stepNodes = {
    topic: document.getElementById('step-topic'),
    story: document.getElementById('step-story'),
    images: document.getElementById('step-images'),
    audio: document.getElementById('step-audio'),
    video: document.getElementById('step-video'),
    db: document.getElementById('step-db')
  };

  // Schedule Automation Controls
  const toggleScheduleEnabled = document.getElementById('toggle-schedule-enabled');
  const scheduleEnabledLabel = document.getElementById('schedule-enabled-label');
  const activeScheduleLabel = document.getElementById('active-schedule-label');
  const activeScheduleCron = document.getElementById('active-schedule-cron');
  const presetChips = document.querySelectorAll('.preset-chip');
  const customCronBox = document.getElementById('custom-cron-box');
  const inputCustomCron = document.getElementById('input-custom-cron');
  const btnSaveSchedule = document.getElementById('btn-save-schedule');
  const scheduleFeedback = document.getElementById('schedule-feedback');

  // Stories Gallery Elements
  const dashboardStoriesGrid = document.getElementById('dashboard-stories-grid');
  const galleryTabs = document.querySelectorAll('.gallery-tab');
  const countFilterAll = document.getElementById('count-filter-all');
  const countFilterReady = document.getElementById('count-filter-ready');
  const countFilterPending = document.getElementById('count-filter-pending');
  const countFilterUploaded = document.getElementById('count-filter-uploaded');

  // Live Console Elements
  const liveConsole = document.getElementById('live-console');
  const btnClearLogs = document.getElementById('btn-clear-logs');

  // Video Player Modal
  const videoPlayerModal = document.getElementById('video-player-modal');
  const videoPlayerClose = document.getElementById('video-player-close');
  const videoPlayerTitle = document.getElementById('video-player-title');
  const videoPlayerSubtitle = document.getElementById('video-player-subtitle');
  const modalVideoElement = document.getElementById('modal-video-element');
  const modalVideoSource = document.getElementById('modal-video-source');
  const btnModalSwitchEn = document.getElementById('btn-modal-switch-en');
  const btnModalSwitchTa = document.getElementById('btn-modal-switch-ta');
  const btnModalDownloadVideo = document.getElementById('btn-modal-download-video');

  // PostgreSQL Modal Elements
  const btnToggleDbModal = document.getElementById('btn-toggle-db-modal');
  const dbModal = document.getElementById('db-modal');
  const dbModalClose = document.getElementById('db-modal-close');
  const btnDbTabStories = document.getElementById('btn-db-tab-stories');
  const btnDbTabUploads = document.getElementById('btn-db-tab-uploads');
  const btnRefreshDbUploads = document.getElementById('btn-refresh-db-uploads');
  const dbStoriesView = document.getElementById('db-stories-view');
  const dbUploadsView = document.getElementById('db-uploads-view');
  const dbStoriesTbody = document.getElementById('db-stories-tbody');
  const dbUploadsTbody = document.getElementById('db-uploads-tbody');

  // =============================================================================
  //  1. DASHBOARD INITIALIZATION
  // =============================================================================

  async function init() {
    await Promise.all([
      fetchOverview(),
      fetchStories(),
      checkSystemHealth()
    ]);

    initSSE();
    startCountdownTimer();
  }

  // =============================================================================
  //  2. OVERVIEW & ACTIVITY CENTER DATA
  // =============================================================================

  async function fetchOverview() {
    try {
      const res = await fetch('/api/dashboard/overview');
      const data = await res.json();
      if (!data.success) return;

      // Update KPIs
      if (kpiTotalStories) kpiTotalStories.textContent = `${data.stats.totalStories} Stories`;
      if (kpiLatestTitle) kpiLatestTitle.textContent = `Latest: ${data.stats.latestStoryTitle.substring(0, 24)}...`;
      if (kpiTotalVideos) kpiTotalVideos.textContent = `${data.stats.videosReady} Subtitled Shorts`;
      if (kpiYoutubeStatus) kpiYoutubeStatus.textContent = `${data.stats.uploaded} Published`;
      if (kpiYoutubeDetail) kpiYoutubeDetail.textContent = `${data.stats.uploaded} Published • ${data.stats.awaitingApproval} Awaiting Approval`;

      // Update Schedule info
      if (data.schedule) {
        if (kpiScheduleLabel) kpiScheduleLabel.textContent = data.schedule.label || 'Every 1 Hour';
        if (kpiScheduleNext) kpiScheduleNext.textContent = data.schedule.text || 'Next run: soon';
        if (activeScheduleLabel) activeScheduleLabel.textContent = data.schedule.label || 'Every 1 Hour';
        if (activeScheduleCron) activeScheduleCron.textContent = data.schedule.expression || '0 * * * *';
        if (toggleScheduleEnabled) toggleScheduleEnabled.checked = data.schedule.enabled;
        if (scheduleEnabledLabel) scheduleEnabledLabel.textContent = data.schedule.enabled ? 'Active' : 'Paused';

        nextRunCountdownSeconds = data.schedule.secondsRemaining || 0;
      }

      // Update Activity (Happening NOW / LATER)
      if (data.activity) {
        renderActivity(data.activity);
      }
    } catch (err) {
      console.warn('Error fetching dashboard overview:', err);
    }
  }

  function renderActivity(activity) {
    const isRunning = activity.status === 'running';
    isExecuting = isRunning;

    // Beacon
    if (activityBeacon && activityBeaconText) {
      if (isRunning) {
        activityBeacon.className = 'activity-status-beacon beacon-running';
        activityBeaconText.textContent = `Running: ${(activity.stage || 'Pipeline').toUpperCase()}`;
      } else {
        activityBeacon.className = 'activity-status-beacon beacon-idle';
        activityBeaconText.textContent = 'System Standby';
      }
    }

    // Elapsed Timer
    if (activityElapsedBadge && activityElapsedTime) {
      if (isRunning) {
        activityElapsedBadge.style.display = 'inline-block';
        if (activity.elapsedSeconds !== undefined) {
          elapsedSeconds = activity.elapsedSeconds;
          formatElapsedTime(elapsedSeconds);
          if (!elapsedInterval) {
            elapsedInterval = setInterval(() => {
              elapsedSeconds++;
              formatElapsedTime(elapsedSeconds);
            }, 1000);
          }
        }
      } else {
        activityElapsedBadge.style.display = 'none';
        if (elapsedInterval) {
          clearInterval(elapsedInterval);
          elapsedInterval = null;
        }
      }
    }

    // Master Trigger button text / state
    if (btnMasterRunPipeline) {
      if (isRunning) {
        btnMasterRunPipeline.disabled = true;
        btnMasterRunPipeline.innerHTML = '⏳ Pipeline in Progress...';
      } else {
        btnMasterRunPipeline.disabled = false;
        btnMasterRunPipeline.innerHTML = '🚀 Run Full Pipeline Now';
      }
    }

    // Progress Bar Fill
    const pct = activity.progress || 0;
    if (stepperProgressFill) {
      stepperProgressFill.style.width = `${pct}%`;
    }

    // Stepper node states
    const stageOrder = ['topic', 'story', 'images', 'audio', 'video', 'db'];
    const currentIdx = stageOrder.indexOf(activity.stage);

    stageOrder.forEach((stg, idx) => {
      const node = stepNodes[stg];
      if (!node) return;
      node.classList.remove('active', 'done');
      if (isRunning) {
        if (idx < currentIdx) {
          node.classList.add('done');
        } else if (idx === currentIdx) {
          node.classList.add('active');
        }
      } else if (activity.lastCompleted) {
        node.classList.add('done');
      }
    });

    // Current Labels
    if (activityCurrentLabel) {
      activityCurrentLabel.textContent = activity.stageLabel || 'System Standby — Waiting for trigger or schedule';
      activityCurrentLabel.style.color = isRunning ? '#38bdf8' : '#e2e8f0';
    }
    if (activityDetailMsg) {
      if (isRunning && activity.title) {
        activityDetailMsg.textContent = `Story: "${activity.title}" (${activity.storyId || ''})`;
      } else if (activity.lastCompleted) {
        activityDetailMsg.textContent = `Last completed story: "${activity.lastCompleted}"`;
      }
    }
  }

  function formatElapsedTime(sec) {
    const mins = String(Math.floor(sec / 60)).padStart(2, '0');
    const rem = String(sec % 60).padStart(2, '0');
    if (activityElapsedTime) activityElapsedTime.textContent = `${mins}:${rem}`;
  }

  function startCountdownTimer() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      if (nextRunCountdownSeconds > 0) {
        nextRunCountdownSeconds--;
        const hours = Math.floor(nextRunCountdownSeconds / 3600);
        const mins = Math.floor((nextRunCountdownSeconds % 3600) / 60);
        const secs = nextRunCountdownSeconds % 60;
        let str = '';
        if (hours > 0) str = `In ${hours}h ${mins}m`;
        else if (mins > 0) str = `In ${mins}m ${secs}s`;
        else str = `In ${secs}s`;

        if (upcomingCountdownText) upcomingCountdownText.textContent = str;
        if (kpiScheduleNext) kpiScheduleNext.textContent = `Next run: ${str}`;
      } else {
        if (upcomingCountdownText) upcomingCountdownText.textContent = 'Due soon';
      }
    }, 1000);
  }

  // =============================================================================
  //  3. STORIES & FINAL VIDEOS GALLERY
  // =============================================================================

  async function fetchStories() {
    try {
      const res = await fetch('/api/dashboard/stories');
      const data = await res.json();
      if (!data.success || !data.stories) return;

      allStories = data.stories;
      updateFilterCounts();
      renderGallery();
    } catch (err) {
      console.warn('Error fetching stories for gallery:', err);
    }
  }

  function updateFilterCounts() {
    const ready = allStories.filter(s => s.has_en_video || s.has_ta_video).length;
    const uploaded = allStories.filter(s => s.is_uploaded).length;
    const pending = allStories.filter(s => !s.is_uploaded).length;

    if (countFilterAll) countFilterAll.textContent = allStories.length;
    if (countFilterReady) countFilterReady.textContent = ready;
    if (countFilterPending) countFilterPending.textContent = pending;
    if (countFilterUploaded) countFilterUploaded.textContent = uploaded;
  }

  function renderGallery() {
    if (!dashboardStoriesGrid) return;

    let filtered = allStories;
    if (currentFilter === 'ready') {
      filtered = allStories.filter(s => s.has_en_video || s.has_ta_video);
    } else if (currentFilter === 'pending') {
      filtered = allStories.filter(s => !s.is_uploaded);
    } else if (currentFilter === 'uploaded') {
      filtered = allStories.filter(s => s.is_uploaded);
    }

    if (filtered.length === 0) {
      dashboardStoriesGrid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 48px; text-align: center; color: var(--text-muted); background: var(--bg-card); border-radius: var(--radius-md); border: 1px dashed var(--border-subtle);">
          <div style="font-size: 2.5rem; margin-bottom: 8px;">🎬</div>
          <h3 style="color: #fff; margin-bottom: 4px;">No Stories Found</h3>
          <p style="font-size: 0.82rem;">No stories match the selected filter. Click "Run Full Pipeline Now" to generate a new story with videos!</p>
        </div>
      `;
      return;
    }

    dashboardStoriesGrid.innerHTML = '';
    filtered.forEach((story, idx) => {
      const card = createStoryCard(story, idx);
      dashboardStoriesGrid.appendChild(card);
    });
  }

  function createStoryCard(story, idx) {
    const card = document.createElement('div');
    card.className = `story-card ${story.is_latest ? 'latest-story' : ''}`;

    // Latest Ribbon
    const latestRibbonHtml = story.is_latest ? `
      <div class="latest-ribbon">
        <span>✨</span> LATEST
      </div>
    ` : '';

    // Status Badge
    let statusBadgeHtml = '';
    if (story.is_uploaded) {
      const ytUrl = story.youtube_en_url || story.youtube_ta_url || 'https://youtube.com';
      statusBadgeHtml = `
        <a href="${ytUrl}" target="_blank" class="btn-published-yt story-badge-topright" title="View Short on YouTube">
          <span>📺</span> Published
        </a>
      `;
    } else {
      statusBadgeHtml = `
        <span class="badge-tag highlight story-badge-topright" style="background: rgba(245, 158, 11, 0.2); border-color: rgba(245, 158, 11, 0.5); color: #fbbf24;">
          ⏳ Awaiting Approval
        </span>
      `;
    }

    // Thumbnail
    const thumbSrc = story.thumbnail || 'https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?w=600&auto=format&fit=crop&q=80';

    // Video buttons
    const enBtn = story.has_en_video ? `
      <button type="button" class="btn-video-play btn-play-en" data-story-id="${story.story_id}" data-lang="en">
        🎬 Play English (9:16)
      </button>
    ` : `
      <button type="button" class="btn-video-play btn-no-video" disabled>
        ⚪ EN Video Pending
      </button>
    `;

    const taBtn = story.has_ta_video ? `
      <button type="button" class="btn-video-play btn-play-ta" data-story-id="${story.story_id}" data-lang="ta">
        🎬 Play Tamil (9:16)
      </button>
    ` : `
      <button type="button" class="btn-video-play btn-no-video" disabled>
        ⚪ TA Video Pending
      </button>
    `;

    // Publish action button
    const publishBtnHtml = !story.is_uploaded && (story.has_en_video || story.has_ta_video) ? `
      <button type="button" class="btn-publish-yt" data-story-id="${story.story_id}" title="Approve and Publish to YouTube Shorts">
        📤 Approve & Publish
      </button>
    ` : (story.is_uploaded ? `
      <a href="${story.youtube_en_url || story.youtube_ta_url}" target="_blank" class="btn-published-yt">
        ↗ View on YouTube
      </a>
    ` : '');

    const dateStr = story.created_at ? new Date(story.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    card.innerHTML = `
      ${latestRibbonHtml}
      ${statusBadgeHtml}
      <div class="story-thumb-wrap">
        <img class="story-thumb-img" src="${thumbSrc}" alt="${story.title_en}" loading="lazy">
        <div class="story-thumb-overlay">
          <div class="play-hover-btn" data-story-id="${story.story_id}" data-lang="en" title="Watch Video">
            ▶
          </div>
        </div>
      </div>
      <div class="story-card-body">
        <h3 class="story-title-en">${story.title_en}</h3>
        <h4 class="story-title-ta">${story.title_ta || ''}</h4>

        <div class="story-meta-pills">
          <span class="pill-theme">🏷️ ${story.theme || 'Story'}</span>
          <span class="pill-theme">🎞️ ${story.scene_count || 6} Scenes</span>
          <span class="pill-theme" style="color: #64748b;">📅 ${dateStr}</span>
        </div>

        <p class="story-moral" title="${story.moral || ''}">
          <strong>Moral:</strong> ${story.moral || 'Kindness brings joy.'}
        </p>

        <div class="video-action-grid">
          ${enBtn}
          ${taBtn}
        </div>

        <div class="story-card-footer">
          <div class="story-footer-actions">
            <button type="button" class="btn-sm btn-outline btn-copy-path" data-path="${(story.folder_url || '').replace(/\\/g, '\\\\')}" title="Copy Folder Path">
              📁 Path
            </button>
            <button type="button" class="btn-sm btn-outline-danger btn-delete-story" data-story-id="${story.story_id}" data-title="${(story.title_en || story.story_id).replace(/"/g, '&quot;')}" title="Delete story folder and files permanently">
              🗑️ Delete
            </button>
          </div>
          ${publishBtnHtml}
        </div>
      </div>
    `;

    // Event listeners
    card.querySelectorAll('.btn-play-en, .play-hover-btn').forEach(btn => {
      btn.addEventListener('click', () => openVideoPlayerModal(story, 'en'));
    });

    card.querySelectorAll('.btn-play-ta').forEach(btn => {
      btn.addEventListener('click', () => openVideoPlayerModal(story, 'ta'));
    });

    card.querySelectorAll('.btn-publish-yt').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await publishStoryToYouTube(story.story_id, btn);
      });
    });

    card.querySelectorAll('.btn-delete-story').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const storyId = btn.getAttribute('data-story-id');
        const title = btn.getAttribute('data-title') || storyId;
        await deleteStory(storyId, title, btn);
      });
    });

    card.querySelectorAll('.btn-copy-path').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = btn.getAttribute('data-path');
        navigator.clipboard.writeText(p);
        const orig = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => { btn.innerHTML = orig; }, 1800);
      });
    });

    return card;
  }

  // Filter Tabs Switching
  galleryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      galleryTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter');
      renderGallery();
    });
  });

  // =============================================================================
  //  4. VIDEO PLAYER MODAL (9:16 VERTICAL SHORTS)
  // =============================================================================

  function openVideoPlayerModal(story, lang = 'en') {
    if (!videoPlayerModal || !modalVideoElement) return;

    activeModalStory = story;
    activeModalLang = lang;

    const streamUrl = lang === 'en' ? story.video_en_stream : story.video_ta_stream;
    if (!streamUrl) {
      alert(`The ${lang.toUpperCase()} video for "${story.title_en}" is not rendered yet.`);
      return;
    }

    if (videoPlayerTitle) videoPlayerTitle.textContent = lang === 'en' ? story.title_en : (story.title_ta || story.title_en);
    if (videoPlayerSubtitle) videoPlayerSubtitle.textContent = `9:16 Vertical Video with Subtitles (${lang === 'en' ? 'English Narration' : 'Tamil Narration'})`;

    modalVideoSource.src = streamUrl;
    modalVideoElement.load();
    modalVideoElement.play().catch(() => {});

    // Update download link
    if (btnModalDownloadVideo) {
      btnModalDownloadVideo.href = streamUrl;
      btnModalDownloadVideo.setAttribute('download', `${story.story_id}_${lang}_video.mp4`);
    }

    // Update switch buttons active state
    if (btnModalSwitchEn && btnModalSwitchTa) {
      if (lang === 'en') {
        btnModalSwitchEn.className = 'btn-sm btn-primary';
        btnModalSwitchTa.className = 'btn-sm btn-outline';
      } else {
        btnModalSwitchEn.className = 'btn-sm btn-outline';
        btnModalSwitchTa.className = 'btn-sm btn-primary';
      }
    }

    videoPlayerModal.classList.add('active');
  }

  function closeVideoPlayerModal() {
    if (!videoPlayerModal) return;
    videoPlayerModal.classList.remove('active');
    if (modalVideoElement) {
      modalVideoElement.pause();
      modalVideoSource.src = '';
    }
  }

  videoPlayerClose?.addEventListener('click', closeVideoPlayerModal);
  videoPlayerModal?.addEventListener('click', (e) => {
    if (e.target === videoPlayerModal) closeVideoPlayerModal();
  });

  btnModalSwitchEn?.addEventListener('click', () => {
    if (activeModalStory) openVideoPlayerModal(activeModalStory, 'en');
  });

  btnModalSwitchTa?.addEventListener('click', () => {
    if (activeModalStory) openVideoPlayerModal(activeModalStory, 'ta');
  });

  // =============================================================================
  //  5. ONE-CLICK MASTER TRIGGER
  // =============================================================================

  btnToggleCustomTopic?.addEventListener('click', () => {
    if (!customTopicDrawer) return;
    customTopicDrawer.style.display = customTopicDrawer.style.display === 'none' ? 'block' : 'none';
  });

  btnMasterRunPipeline?.addEventListener('click', async () => {
    await runPipelineTrigger(null);
  });

  btnSubmitCustomPipeline?.addEventListener('click', async () => {
    const customTopic = inputCustomTopic?.value?.trim();
    if (!customTopic) {
      alert('Please enter a custom story topic.');
      return;
    }
    await runPipelineTrigger(customTopic);
  });

  async function runPipelineTrigger(topic = null) {
    if (btnMasterRunPipeline) btnMasterRunPipeline.disabled = true;
    try {
      const res = await fetch('/api/pipeline/run-full', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: topic || undefined })
      });
      const data = await res.json();
      if (data.success) {
        logToConsole('[System]', 'info', `🚀 Pipeline triggered! ${data.message}`);
        setTimeout(fetchOverview, 1500);
      } else {
        alert(`Pipeline error: ${data.error || 'Failed'}`);
      }
    } catch (e) {
      alert(`Request failed: ${e.message}`);
    }
  }

  // =============================================================================
  //  6. CHANGE SCHEDULE TIMINGS
  // =============================================================================

  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      presetChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      const cronVal = chip.getAttribute('data-cron');
      if (cronVal === 'custom') {
        if (customCronBox) customCronBox.style.display = 'block';
      } else {
        if (customCronBox) customCronBox.style.display = 'none';
        if (inputCustomCron) inputCustomCron.value = cronVal;
      }
    });
  });

  toggleScheduleEnabled?.addEventListener('change', () => {
    if (scheduleEnabledLabel) {
      scheduleEnabledLabel.textContent = toggleScheduleEnabled.checked ? 'Active' : 'Paused';
    }
  });

  btnSaveSchedule?.addEventListener('click', async () => {
    btnSaveSchedule.disabled = true;
    btnSaveSchedule.textContent = 'Saving...';

    const activeChip = document.querySelector('.preset-chip.active');
    let expr = activeChip?.getAttribute('data-cron');
    if (expr === 'custom' || !expr) {
      expr = inputCustomCron?.value?.trim() || '0 * * * *';
    }
    const enabled = toggleScheduleEnabled?.checked !== false;

    try {
      const res = await fetch('/api/schedule/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: expr, enabled })
      });
      const data = await res.json();
      if (data.success) {
        if (scheduleFeedback) {
          scheduleFeedback.textContent = `✅ Saved! ${data.label} (${data.expression}) — ${data.text}`;
          setTimeout(() => { scheduleFeedback.textContent = ''; }, 4000);
        }
        await fetchOverview();
      } else {
        alert(`Error: ${data.error || 'Failed to update schedule'}`);
      }
    } catch (e) {
      alert(`Schedule update failed: ${e.message}`);
    } finally {
      btnSaveSchedule.disabled = false;
      btnSaveSchedule.textContent = '💾 Save & Apply Schedule';
    }
  });

  // =============================================================================
  //  7. APPROVE & PUBLISH TO YOUTUBE
  // =============================================================================

  async function publishStoryToYouTube(storyId, btnElement) {
    if (!confirm(`Are you sure you want to approve and publish "${storyId}" to YouTube Shorts?`)) {
      return;
    }

    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = '⏳ Uploading to YouTube...';
    }

    try {
      const res = await fetch(`/api/stories/${encodeURIComponent(storyId)}/publish`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.success) {
        alert('🎉 Story published to YouTube Shorts successfully!');
        await Promise.all([fetchOverview(), fetchStories()]);
      } else if (data.requiresAuth || res.status === 401 || (data.error && data.error.includes('OAuth'))) {
        const confirmAuth = confirm('⚠️ YouTube is not authenticated yet.\n\nWould you like to open the Google Authorization page now to link your YouTube channel?');
        if (confirmAuth) {
          window.open('/auth/youtube', '_blank');
        }
      } else {
        const enErr = data.details?.en;
        const taErr = data.details?.ta;
        let msg = data.error || 'Upload failed.';
        if (enErr || taErr) {
          msg += `\n\nDetails:\n• English: ${enErr || 'OK'}\n• Tamil: ${taErr || 'OK'}`;
        }
        alert(`❌ YouTube Upload Failed:\n\n${msg}`);
      }
    } catch (e) {
      alert(`Publish request failed: ${e.message}`);
    } finally {
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.textContent = '📤 Approve & Publish';
      }
    }
  }

  async function deleteStory(storyId, title, btnElement) {
    const confirmed = confirm(`⚠️ Are you sure you want to permanently delete this story folder?\n\n"${title}"\n(${storyId})\n\nThis will delete all scene images, narration audios, assembled MP4 videos, and remove the database records. This cannot be undone.`);
    if (!confirmed) return;

    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = '⏳ Deleting...';
    }

    try {
      const res = await fetch(`/api/stories/${encodeURIComponent(storyId)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        // Visual removal animation
        const card = btnElement?.closest('.story-card');
        if (card) {
          card.style.transition = 'all 0.35s ease';
          card.style.opacity = '0';
          card.style.transform = 'scale(0.85)';
          setTimeout(() => {
            card.remove();
          }, 350);
        }
        await Promise.all([fetchOverview(), fetchStories()]);
      } else {
        alert(`❌ Failed to delete story: ${data.error || 'Unknown error'}`);
        if (btnElement) {
          btnElement.disabled = false;
          btnElement.textContent = '🗑️ Delete';
        }
      }
    } catch (e) {
      alert(`❌ Network error while deleting: ${e.message}`);
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.textContent = '🗑️ Delete';
      }
    }
  }

  // =============================================================================
  //  8. REAL-TIME SERVER-SENT EVENTS (SSE)
  // =============================================================================

  function initSSE() {
    const evtSource = new EventSource('/api/pipeline/logs/stream');

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'activity' && data.activity) {
          renderActivity(data.activity);
        } else if (data.message) {
          logToConsole(data.stage || 'pipeline', data.level || 'info', data.message);
          if (data.activity) {
            renderActivity(data.activity);
          }
          // On completion, refresh gallery automatically
          if (data.level === 'success' && data.message.includes('Complete')) {
            setTimeout(() => {
              fetchOverview();
              fetchStories();
            }, 2500);
          }
        }
      } catch (_) {}
    };

    evtSource.onerror = () => {
      // Reconnection handled automatically by browser
    };
  }

  function logToConsole(stage, level, msg) {
    if (!liveConsole) return;
    const time = new Date().toLocaleTimeString();

    let color = '#94a3b8';
    if (level === 'success') color = '#34d399';
    else if (level === 'warn') color = '#fbbf24';
    else if (level === 'error') color = '#f87171';
    else if (level === 'skip') color = '#c084fc';

    const line = document.createElement('div');
    line.style.marginBottom = '2px';
    line.innerHTML = `<span style="color:#64748b;">[${time}]</span> <span style="color:#00f2fe;font-weight:600;">[${(stage || 'system').toUpperCase()}]</span> <span style="color:${color};">${msg}</span>`;

    liveConsole.appendChild(line);
    liveConsole.scrollTop = liveConsole.scrollHeight;
  }

  btnClearLogs?.addEventListener('click', () => {
    if (liveConsole) liveConsole.innerHTML = '<div style="color: #64748b;">[Console cleared]</div>';
  });

  // =============================================================================
  //  9. POSTGRESQL DATABASE MODAL
  // =============================================================================

  btnToggleDbModal?.addEventListener('click', () => {
    if (dbModal) {
      dbModal.classList.add('active');
      fetchDbStories();
    }
  });

  dbModalClose?.addEventListener('click', () => {
    if (dbModal) dbModal.classList.remove('active');
  });

  btnDbTabStories?.addEventListener('click', () => {
    btnDbTabStories.className = 'btn-sm btn-primary';
    btnDbTabUploads.className = 'btn-sm btn-outline';
    if (dbStoriesView) dbStoriesView.style.display = 'block';
    if (dbUploadsView) dbUploadsView.style.display = 'none';
    fetchDbStories();
  });

  btnDbTabUploads?.addEventListener('click', () => {
    btnDbTabUploads.className = 'btn-sm btn-primary';
    btnDbTabStories.className = 'btn-sm btn-outline';
    if (dbStoriesView) dbStoriesView.style.display = 'none';
    if (dbUploadsView) dbUploadsView.style.display = 'block';
    fetchDbUploads();
  });

  btnRefreshDbUploads?.addEventListener('click', () => {
    if (dbStoriesView && dbStoriesView.style.display !== 'none') {
      fetchDbStories();
    } else {
      fetchDbUploads();
    }
  });

  async function fetchDbStories() {
    if (!dbStoriesTbody) return;
    dbStoriesTbody.innerHTML = '<tr><td colspan="8" style="padding: 20px; text-align: center; color: #64748b;">Fetching stories from PostgreSQL...</td></tr>';
    try {
      const res = await fetch('/api/db/stories');
      const data = await res.json();
      if (!data.success || !data.stories || data.stories.length === 0) {
        dbStoriesTbody.innerHTML = '<tr><td colspan="8" style="padding: 20px; text-align: center; color: #94a3b8;">No stories recorded in PostgreSQL yet.</td></tr>';
        return;
      }

      dbStoriesTbody.innerHTML = '';
      data.stories.forEach(s => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        const folderLink = s.folder_url ? `<span title="${s.folder_url}" style="color:#a1a1aa; cursor:pointer;" onclick="navigator.clipboard.writeText('${s.folder_url.replace(/\\/g, '\\\\')}'); alert('Copied path: ${s.folder_url.replace(/\\/g, '\\\\')}');">📁 ${s.story_id.slice(-15)}</span>` : '-';
        const enVideoLink = s.video_en_url ? `<span title="${s.video_en_url}" style="color:#38bdf8; cursor:pointer;" onclick="navigator.clipboard.writeText('${s.video_en_url.replace(/\\/g, '\\\\')}'); alert('Copied: en_video.mp4');">🎬 en_video.mp4</span>` : '-';
        const taVideoLink = s.video_ta_url ? `<span title="${s.video_ta_url}" style="color:#c084fc; cursor:pointer;" onclick="navigator.clipboard.writeText('${s.video_ta_url.replace(/\\/g, '\\\\')}'); alert('Copied: ta_video.mp4');">🎬 ta_video.mp4</span>` : '-';
        const ytIds = (s.youtube_en_id || s.youtube_ta_id) ? `EN: ${s.youtube_en_id || '-'} / TA: ${s.youtube_ta_id || '-'}` : '-';

        tr.innerHTML = `
          <td style="padding: 8px; color: #f8fafc; font-weight:600;" title="${s.story_id}">${s.story_id}</td>
          <td style="padding: 8px;">
            <div style="color: #e2e8f0; font-weight:500;">${s.title_en || '-'}</div>
            <div style="color: #94a3b8; font-size: 0.72rem;">${s.title_ta || ''}</div>
          </td>
          <td style="padding: 8px; max-width: 220px;">
            <div style="color: #cbd5e1;">${s.theme || '-'}</div>
            <div style="color: #64748b; font-size: 0.72rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${s.moral || ''}">${s.moral || ''}</div>
          </td>
          <td style="padding: 8px;"><span class="badge-tag highlight" style="font-size:0.7rem;">${s.status || 'awaiting_approval'}</span></td>
          <td style="padding: 8px;">${folderLink}</td>
          <td style="padding: 8px;">${enVideoLink}</td>
          <td style="padding: 8px;">${taVideoLink}</td>
          <td style="padding: 8px; color: #94a3b8; font-size:0.75rem;">${ytIds}</td>
        `;
        dbStoriesTbody.appendChild(tr);
      });
    } catch (err) {
      dbStoriesTbody.innerHTML = `<tr><td colspan="8" style="padding: 20px; text-align: center; color: #f87171;">Error: ${err.message}</td></tr>`;
    }
  }

  async function fetchDbUploads() {
    if (!dbUploadsTbody) return;
    dbUploadsTbody.innerHTML = '<tr><td colspan="7" style="padding: 20px; text-align: center; color: #64748b;">Fetching PostgreSQL uploads...</td></tr>';
    try {
      const res = await fetch('/api/db/uploads');
      const data = await res.json();
      if (!data.success || !data.uploads || data.uploads.length === 0) {
        dbUploadsTbody.innerHTML = '<tr><td colspan="7" style="padding: 20px; text-align: center; color: #94a3b8;">No file upload records in PostgreSQL yet.</td></tr>';
        return;
      }

      dbUploadsTbody.innerHTML = '';
      data.uploads.forEach(u => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
        const sizeMb = u.file_size ? `${(u.file_size / (1024 * 1024)).toFixed(1)} MB` : '-';
        const isSuccess = u.status === 'completed';
        const link = u.remote_url ? `<a href="${u.remote_url}" target="_blank" style="color:#38bdf8; text-decoration:underline;">View Link ↗</a>` : '-';
        const time = new Date(u.created_at).toLocaleString();

        tr.innerHTML = `
          <td style="padding: 8px; color: #f8fafc;" title="${u.story_id}">${u.story_id.substring(0, 20)}...</td>
          <td style="padding: 8px; color: #e2e8f0;">${u.file_name}</td>
          <td style="padding: 8px;"><span class="badge-tag" style="font-size:0.7rem;">${u.destination.toUpperCase()}</span></td>
          <td style="padding: 8px; color: #94a3b8;">${sizeMb}</td>
          <td style="padding: 8px; color: ${isSuccess ? '#4ade80' : '#f87171'}; font-weight:600;">${u.status}</td>
          <td style="padding: 8px;">${link}</td>
          <td style="padding: 8px; color: #64748b; font-size:0.75rem;">${time}</td>
        `;
        dbUploadsTbody.appendChild(tr);
      });
    } catch (err) {
      dbUploadsTbody.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: #f87171;">Error: ${err.message}</td></tr>`;
    }
  }

  // =============================================================================
  //  10. SYSTEM HEALTH CHECK
  // =============================================================================

  async function checkSystemHealth() {
    try {
      const [resStatus, resYt] = await Promise.all([
        fetch('/api/status').catch(() => null),
        fetch('/api/youtube/channel-status').catch(() => null)
      ]);

      if (resStatus && resStatus.ok) {
        const data = await resStatus.json();
        if (data.success && statusAgy) {
          const dot = statusAgy.querySelector('.status-dot');
          if (dot) dot.style.background = data.antigravity?.available ? '#34d399' : '#f87171';
        }
      }

      if (resYt && resYt.ok) {
        const ytData = await resYt.json();
        if (statusYt) {
          const dot = statusYt.querySelector('.status-dot');
          if (dot) {
            dot.style.background = ytData.authenticated ? '#34d399' : '#f87171';
          }
          statusYt.title = ytData.authenticated
            ? 'YouTube Shorts: Connected & Authenticated (Click to re-auth)'
            : 'YouTube Shorts: Not Authenticated — Click here to connect';
        }
      }
    } catch (_) {}
  }

  if (statusYt) {
    statusYt.style.cursor = 'pointer';
    statusYt.addEventListener('click', () => {
      window.open('/auth/youtube', '_blank');
    });
  }

  btnRefreshAll?.addEventListener('click', async () => {
    btnRefreshAll.classList.add('pulse-btn');
    await Promise.all([fetchOverview(), fetchStories()]);
    setTimeout(() => { btnRefreshAll.classList.remove('pulse-btn'); }, 1000);
  });

  // Start app
  init();
});
