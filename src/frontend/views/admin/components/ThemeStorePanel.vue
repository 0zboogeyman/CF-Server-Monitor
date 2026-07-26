<template>
  <div id="tab-theme-store" class="tab-content" :class="{ active: activeTab === 'themeStore' }">
    <div class="settings-section">
      <div class="section-title"><span>▸</span> {{ trans.themeStore }}</div>

      <div class="warning-box mb-4">
        <div class="flex-center-gap-sm">
          <span class="warning-icon text-xl">⚠️</span>
          <span style="color: var(--accent-yellow); font-weight: 600;">{{ trans.themeStoreWarning }}</span>
        </div>
        <p class="text-secondary text-sm mt-2" style="line-height: 1.6;">{{ trans.themeStoreWarningDesc }}</p>
      </div>

      <div v-if="loading" class="theme-loading">
        <div class="loading-spinner"></div>
        <div class="loading-text">$ {{ trans.themeStoreLoading }}...</div>
      </div>

      <div v-else-if="error" class="danger-box mb-4">
        <div class="flex-center-gap-sm">
          <span class="danger-icon text-xl">❌</span>
          <span class="danger-label">{{ error }}</span>
        </div>
        <button @click="loadThemes" class="btn btn-lg mt-2">↻ {{ trans.refresh }}</button>
      </div>

      <div v-else-if="themes.length === 0" class="warning-box mb-4">
        {{ trans.themeStoreEmpty }}
      </div>

      <div v-else class="theme-grid">
        <div v-for="theme in themes" :key="theme.id" class="theme-card">
          <div class="theme-cover-wrap">
            <img :src="theme.cover" :alt="theme.title" class="theme-cover" @error="handleCoverError" />
          </div>
          <div class="theme-info">
            <div class="theme-header">
              <h3 class="theme-title">{{ theme.title }}</h3>
              <span v-if="getLatestVersion(theme)" class="theme-version">{{ getLatestVersion(theme).version }}</span>
            </div>
            <div v-if="theme.tags && theme.tags.length" class="theme-tags">
              <span v-for="tag in theme.tags" :key="tag" class="theme-tag">{{ tag }}</span>
            </div>
            <p v-if="getThemeDescription(theme)" class="theme-desc">{{ getThemeDescription(theme) }}</p>
            <div v-if="theme.author" class="theme-author">by {{ theme.author }}</div>
            
            <!-- 版本选择 -->
            <div v-if="theme.versions && theme.versions.length > 0" class="theme-version-selector">
              <label class="version-label">{{ trans.version }}</label>
              <select 
                :value="selectedVersions[theme.id] || 0" 
                @change="selectVersion(theme.id, $event.target.value)"
                class="version-select"
              >
                <option v-for="(v, idx) in theme.versions" :key="v.version" :value="idx">
                  {{ v.version }}
                </option>
              </select>
            </div>

            <!-- 当前选中版本信息 -->
            <div v-if="getSelectedVersion(theme)" class="theme-version-info">
              <div v-if="getSelectedVersion(theme).releaseDate" class="version-date">
                📅 {{ getSelectedVersion(theme).releaseDate }}
              </div>
              <div v-if="getSelectedVersion(theme).changelog" class="version-changelog">
                <div class="changelog-label">{{ trans.changelog }}</div>
                <div class="changelog-content">{{ getSelectedVersion(theme).changelog }}</div>
              </div>
            </div>

            <div class="theme-actions">
              <button v-if="theme.preview" @click="openPreview(theme)" class="btn btn-sm">👁 {{ trans.preview }}</button>
              <a v-if="getSafeExternalUrl(theme.demo)" :href="getSafeExternalUrl(theme.demo)" target="_blank" rel="noopener noreferrer" class="btn btn-sm">▶ {{ trans.demo }}</a>
              <a v-if="getSafeExternalUrl(theme.url)" :href="getSafeExternalUrl(theme.url)" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-primary">↗ {{ trans.view }}</a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Preview Modal -->
    <div v-if="previewTheme" class="modal-overlay active" @click.self="previewTheme = null">
      <div class="modal-dialog modal-lg">
        <div class="modal-header">
          <div class="modal-title">{{ previewTheme.title }}</div>
          <button class="modal-close" @click="previewTheme = null">✕</button>
        </div>
        <div class="modal-body">
          <img :src="previewTheme.preview" :alt="previewTheme.title" class="theme-preview-img" @error="handlePreviewError" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, reactive } from 'vue'
import http from '../../../utils/http'
import { currentLang } from '../../../utils/i18n'

const props = defineProps({
  trans: { type: Object, required: true },
  activeTab: { type: String, default: '' }
})

const themes = ref([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const previewTheme = ref(null)
const selectedVersions = reactive({})

const loadThemes = async () => {
  if (loading.value) return

  loading.value = true
  error.value = ''
  try {
    const result = await http.get('/theme')
    if (result.error) throw new Error(result.error)
    themes.value = Array.isArray(result.data?.themes) ? result.data.themes : []
    
    // 初始化选中版本为最新版本（索引0）
    themes.value.forEach(theme => {
      if (theme.versions && theme.versions.length > 0) {
        selectedVersions[theme.id] = 0
      }
    })
    
    loaded.value = true
  } catch (e) {
    error.value = e.message || 'Failed to load themes'
    loaded.value = false
  } finally {
    loading.value = false
  }
}

const openPreview = (theme) => {
  previewTheme.value = theme
}

const getLatestVersion = (theme) => {
  if (!theme.versions || !theme.versions.length) return null
  return theme.versions[0]
}

const getSelectedVersion = (theme) => {
  if (!theme.versions || !theme.versions.length) return null
  const idx = selectedVersions[theme.id] || 0
  return theme.versions[idx] || null
}

const selectVersion = (themeId, idx) => {
  selectedVersions[themeId] = parseInt(idx)
}

const getThemeDescription = (theme) => {
  const description = theme?.description
  if (!description || typeof description !== 'object' || Array.isArray(description)) {
    return ''
  }

  const keys = currentLang.value === 'zh'
    ? ['zh-CN', 'en']
    : ['en', 'zh-CN']

  for (const key of keys) {
    if (typeof description[key] === 'string' && description[key].trim()) {
      return description[key]
    }
  }

  return Object.values(description).find(value => typeof value === 'string' && value.trim()) || ''
}

const getSafeExternalUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch (_) {
    return ''
  }
}

const handleCoverError = (e) => {
  e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225"><rect fill="%231a1a2e" width="400" height="225"/><text fill="%23666" font-family="monospace" font-size="16" x="200" y="112" text-anchor="middle">No Preview</text></svg>'
}

const handlePreviewError = (e) => {
  e.target.style.display = 'none'
}

watch(
  () => props.activeTab,
  (activeTab) => {
    if (activeTab === 'themeStore' && !loaded.value) {
      loadThemes()
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.theme-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.theme-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.theme-card:hover {
  border-color: var(--accent-green);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
}

.theme-cover-wrap {
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--bg-secondary, #1a1a2e);
}

.theme-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.theme-info {
  padding: 12px 14px;
}

.theme-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.theme-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.theme-version {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-hover, rgba(255,255,255,0.05));
  padding: 2px 6px;
  border-radius: 3px;
  font-family: var(--terminal-font);
}

.theme-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.theme-tag {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-green);
  color: var(--color-inherit, #fff);
  border-radius: 3px;
  font-family: var(--terminal-font);
  opacity: 0.85;
}

.theme-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.theme-author {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 10px;
  opacity: 0.7;
}

.theme-version-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.version-label {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.version-select {
  flex: 1;
  font-size: 11px;
  padding: 4px 8px;
  background: var(--bg-secondary, #1a1a2e);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  color: var(--text-primary);
  font-family: var(--terminal-font);
  cursor: pointer;
}

.version-select:focus {
  outline: none;
  border-color: var(--accent-green);
}

.theme-version-info {
  margin-bottom: 10px;
  padding: 6px 8px;
  background: var(--bg-hover, rgba(255,255,255,0.03));
  border-radius: 3px;
}

.version-date {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.version-changelog {
  font-size: 11px;
}

.changelog-label {
  color: var(--accent-green);
  font-weight: 500;
  margin-bottom: 2px;
}

.changelog-content {
  color: var(--text-secondary);
  line-height: 1.4;
}

.theme-actions {
  display: flex;
  gap: 8px;
}

.theme-actions .btn {
  flex: 1;
  text-align: center;
  text-decoration: none;
  font-size: 12px;
  padding: 6px 12px;
}

.modal-lg .modal-body {
  padding: 0;
}

.theme-preview-img {
  width: 100%;
  display: block;
  border-radius: 0 0 6px 6px;
}
</style>
