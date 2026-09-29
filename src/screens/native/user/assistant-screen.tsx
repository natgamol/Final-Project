import {useEffect, useMemo, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NativeDateTimePicker from '@/components/date-time-picker';
import ScheduleConflictDialog from '@/components/schedule-conflict-dialog';
import ConfirmDialog from '@/components/confirm-dialog';
import {ActivityIndicator, Animated, KeyboardAvoidingView, Modal, NativeModules, PermissionsAndroid, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';
import {router} from 'expo-router';

import {AsyncActionOverlay, type AsyncActionStatus} from '@/components/async-action-ui';
import {Reveal} from '@/components/motion';
import {useTourTarget} from '@/hooks/use-tour-target';
import {useTour} from '@/providers/tour-provider';
import {appCheckErrorMessage, isAppCheckError} from '@/lib/app-check';
import {explicitMutationClause, isReadOnlyOrAdviceRequest} from '@/services/assistant-action-intent';
import {buildAssistantReply, confirmAssistantAction, recordAssistantTelemetry, type AssistantReply} from '@/services/assistant-tools';
import {adaptiveScheduling, type AdaptiveDashboard, type AdaptiveProposedActivity, type AdaptiveSuggestion} from '@/services/adaptive-scheduling';
import {
  assistantActiveConversationKey,
  assistantConversationHistoryKey,
  assistantConversationStateKey,
  createAssistantConversationId,
  createAssistantConversationState,
  mergeAssistantConversationState,
  parseAssistantConversationState,
  updateAssistantConversationState,
} from '@/services/assistant-conversation';
import {classifyAssistantIntent} from '@/services/assistant-intent';
import {editScheduleDraft} from '@/services/assistant-draft-edit';
import {uploadAndAnalyzeAssistantFile} from '@/services/assistant-file';
import {assistantActionErrorMessage, assistantErrorMessage, classifyAssistantError} from '@/services/assistant-error';
import {calculateBurnoutDynamicInsight} from '@/services/dynamic-insights';
import {baselineNightHours, loadSleepBaseline} from '@/services/sleep-log';
import RiskMeter from '@/components/risk-meter';
import {burnoutRiskBand} from '@/constants/burnout-risk';
import {
  deleteAssistantConversation,
  listAssistantConversations,
  loadAssistantConversation,
  saveAssistantMessage,
  updateAssistantMessagePayload,
  type AssistantConversationSummary,
} from '@/services/assistant-history';
import {loadLegacyPageData} from '@/services/legacy-data';
import {sanitizeAssistantMessages} from '@/services/assistant-message-sanitizer';
import {transcribeAssistantAudio} from '@/services/assistant-voice';
import {recordTaskCompleted} from '@/services/behavior-tracking';
import type {AssistantChatMessage, AssistantConversationState, AssistantFeedbackRating, AssistantPendingTaskShortcut, AssistantProposedAction, ProposedActionStatus} from '@/types/assistant';
import {activities, type ScheduleConflict} from '@/services/firestore';
import type {Activity, Schedule, WithId} from '@/types/smartlife';
import {Card, MaterialIcon, UserShell, type UserNavigate, userStyles} from './user-ui';
import {showToast} from '@/components/app-toast';
import {useCurrentClock} from '@/hooks/use-current-clock';

function nowIso() {
  return new Date().toISOString();
}

function messageId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_STORED_CHAT_MESSAGES = 180;
const THAI_TIME_ZONE = 'Asia/Bangkok';

function assistantIntroMessage(): AssistantChatMessage {
  return {
    content: 'ถามฉันได้เลยนะ จะดูตาราง เงิน หรือให้ช่วยจด/เพิ่มรายการก็ได้ ถ้าจะให้ฉันเพิ่มข้อมูล ฉันจะทำเป็นการ์ดให้ยืนยันก่อนเสมอ',
    id: 'assistant-intro',
    role: 'assistant',
    timestamp: nowIso(),
  };
}

function assistantBriefingKey(uid: string) {
  return `smartlife:assistant:last-briefing-date:${uid}`;
}

function thailandDateKey(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {day: '2-digit', month: '2-digit', timeZone: THAI_TIME_ZONE, year: 'numeric'}).format(value);
}

function trimChatHistory(messages: AssistantChatMessage[]) {
  return messages.slice(-MAX_STORED_CHAT_MESSAGES);
}

function parseStoredMessages(raw: string | null): AssistantChatMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sanitizeAssistantMessages(parsed.filter((message) => {
      return message
        && typeof message.id === 'string'
        && (message.role === 'assistant' || message.role === 'user')
        && typeof message.content === 'string'
        && typeof message.timestamp === 'string';
    }).slice(-MAX_STORED_CHAT_MESSAGES));
  } catch {
    return [];
  }
}

async function requestMicrophonePermission() {
  if (Platform.OS !== 'android') return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    buttonNegative: 'ยกเลิก',
    buttonPositive: 'อนุญาต',
    message: 'SmartLife ต้องใช้ไมโครโฟนเพื่อแปลงเสียงพูดเป็นข้อความในช่องแชท',
    title: 'อนุญาตใช้ไมโครโฟน',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

async function loadVoiceInputModule() {
  // @react-native-voice/voice 3.2.4 registers the Android module as RCTVoice,
  // while its JavaScript entry point still looks for NativeModules.Voice.
  // Alias both names before importing the library so an already-built APK works.
  const nativeVoice = NativeModules.Voice ?? NativeModules.RCTVoice;
  if (!nativeVoice) return null;
  if (!NativeModules.Voice) {
    try {
      NativeModules.Voice = nativeVoice;
    } catch {
      try {
        Object.defineProperty(NativeModules, 'Voice', {configurable: true, value: nativeVoice});
      } catch {
        return null;
      }
    }
  }
  return (await import('@react-native-voice/voice')).default;
}

type BrowserSpeechRecognitionResult = {
  [index: number]: {transcript?: string};
  length: number;
};

type BrowserSpeechRecognition = {
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: {error?: string}) => void) | null;
  onresult: ((event: {resultIndex?: number; results: ArrayLike<BrowserSpeechRecognitionResult>}) => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function createBrowserSpeechRecognition() {
  if (Platform.OS !== 'web') return null;
  const browserGlobal = globalThis as typeof globalThis & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  const SpeechRecognition = browserGlobal.SpeechRecognition ?? browserGlobal.webkitSpeechRecognition;
  return SpeechRecognition ? new SpeechRecognition() : null;
}

function preferredBrowserAudioMimeType() {
  if (Platform.OS !== 'web' || typeof MediaRecorder === 'undefined') return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
}

function validTimeZone(timeZone?: string) {
  if (!timeZone) return THAI_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone}).format(new Date(0));
    return timeZone;
  } catch {
    return THAI_TIME_ZONE;
  }
}

function formatDate(value: string, timeZone = THAI_TIME_ZONE) {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: validTimeZone(timeZone),
  }).format(new Date(value));
}

type ZonedDateTimeParts = {day: number; hour: number; minute: number; month: number; year: number};

function assistantZonedParts(value: Date, timeZone: string): ZonedDateTimeParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {calendar: 'iso8601', day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', numberingSystem: 'latn', timeZone, year: 'numeric'}).formatToParts(value);
    const read = (part: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === part)?.value);
    const result = {day: read('day'), hour: read('hour'), minute: read('minute'), month: read('month'), year: read('year')};
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch { return null; }
}

function assistantLocalInput(value: string, timeZone: string) {
  const parts = assistantZonedParts(new Date(value), timeZone);
  if (!parts) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

function parseAssistantLocalInput(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const intended = {day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]), month: Number(match[2]), year: Number(match[1])};
  const intendedUtc = new Date(Date.UTC(intended.year, intended.month - 1, intended.day, intended.hour, intended.minute));
  if (intendedUtc.getUTCFullYear() !== intended.year || intendedUtc.getUTCMonth() + 1 !== intended.month || intendedUtc.getUTCDate() !== intended.day || intended.hour > 23 || intended.minute > 59) return null;
  const asUtcMs = intendedUtc.getTime();
  const offsetAt = (instantMs: number) => {
    const parts = assistantZonedParts(new Date(instantMs), timeZone);
    return parts ? Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instantMs : null;
  };
  const firstOffset = offsetAt(asUtcMs);
  if (firstOffset === null) return null;
  let instantMs = asUtcMs - firstOffset;
  const correctedOffset = offsetAt(instantMs);
  if (correctedOffset === null) return null;
  instantMs = asUtcMs - correctedOffset;
  const date = new Date(instantMs);
  const verified = assistantZonedParts(date, timeZone);
  return verified && verified.year === intended.year && verified.month === intended.month && verified.day === intended.day && verified.hour === intended.hour && verified.minute === intended.minute ? date : null;
}

function actionDetails(action: AssistantProposedAction) {
  if (action.entity === 'memory') {
    return [
      ['การตั้งค่า', action.payload.key === 'dailyBudget' ? 'งบต่อวัน' : 'ช่วงโฟกัสเรียน'],
      ['ค่าใหม่', action.payload.key === 'dailyBudget' ? `${action.payload.value.toLocaleString('th-TH')} บาท` : `${action.payload.value.toLocaleString('th-TH')} นาที`],
      ['บันทึกที่', 'เครื่องนี้เท่านั้น'],
    ];
  }
  if (action.entity === 'checklist') {
    return [
      ['หัวข้องาน', action.payload.title],
      ['งานย่อย', `${action.payload.items.length} ข้อ`],
      ['รายการ', action.payload.items.map((item, index) => `${index + 1}. ${item}`).join('\n')],
    ];
  }
  if (action.entity === 'finance') {
    return [
      ['ประเภท', action.payload.type === 'income' ? 'รายรับ' : 'รายจ่าย'],
      ['จำนวน', `${action.payload.amount.toLocaleString('th-TH')} บาท`],
      ['หมวด', action.payload.category],
      ['บันทึก', action.payload.note || '-'],
    ];
  }
  if (action.entity === 'note') {
    return [
      ['หัวข้อ', action.payload.title],
      ['แท็ก', action.payload.tag],
      ['เนื้อหา', action.payload.body],
    ];
  }
  return [
    ['ประเภท', action.payload.type === 'class' ? 'คลาสเรียน' : action.payload.type === 'task' ? 'งาน' : 'นัดหมาย'],
    ['หัวข้อ', action.payload.title],
    ['เวลาเริ่ม', formatDate(action.payload.startAt, action.payload.generatedForTimeZone)],
    ['เวลาจบ', action.payload.endAt ? formatDate(action.payload.endAt, action.payload.generatedForTimeZone) : '-'],
    ...(action.payload.isFlexible ? [
      ['Adaptive', 'ย้ายเวลาได้'],
      ['ระยะเวลา', `${action.payload.estimatedDurationMinutes ?? 60} นาที`],
    ] : []),
    ['สถานที่', action.payload.location || '-'],
  ];
}

function MessageBubble({
  message,
  onAsk,
  onCompleteTask,
  onConfirm,
  onFeedback,
  onReject,
  onSpeak,
  speaking,
  busy,
  completingTaskId,
  savingActionId,
}: {
  busy: boolean;
  completingTaskId: string;
  message: AssistantChatMessage;
  onAsk: (message: string) => void;
  onCompleteTask: (messageIdValue: string, task: AssistantPendingTaskShortcut) => void;
  onConfirm: (messageIdValue: string, action: AssistantProposedAction) => void;
  onFeedback: (message: AssistantChatMessage, rating: AssistantFeedbackRating) => void;
  onReject: (messageIdValue: string, action: AssistantProposedAction) => void;
  onSpeak: (message: AssistantChatMessage) => void;
  speaking: boolean;
  savingActionId: string;
}) {
  const isUser = message.role === 'user';
  return (
    <View style={[local.messageRow, isUser && local.messageRowUser]}>
      <View style={[local.bubble, isUser ? local.userBubble : local.assistantBubble]}>
        <Text style={[local.bubbleText, isUser && local.userBubbleText]}>{message.content}</Text>
        {/* Refactored UI: structured assistant results stay inside the AI response bubble. */}
        {!isUser && message.proposedAction ? (
          <ActionCard
            action={message.proposedAction}
            busy={busy}
            saving={savingActionId === message.proposedAction.id}
            onConfirm={(updatedAction) => onConfirm(message.id, updatedAction)}
            onReject={() => onReject(message.id, message.proposedAction as AssistantProposedAction)}
          />
        ) : null}
        {!isUser && message.pendingTaskShortcuts?.length ? (
          <View style={local.pendingTaskList}>
            {message.pendingTaskShortcuts.map((task) => {
              const completed = task.status === 'completed';
              const completing = completingTaskId === task.id;
              return (
                <View key={task.id} style={local.pendingTaskRow}>
                  <View style={local.pendingTaskCopy}>
                    <Text numberOfLines={2} style={local.pendingTaskTitle}>{task.title}</Text>
                    <Text style={local.pendingTaskDue}>{task.dueAt ? `กำหนด ${formatDate(task.dueAt)}` : 'ไม่ระบุกำหนด'}</Text>
                  </View>
                  <Touchable
                    accessibilityLabel={completed ? `${task.title} เสร็จแล้ว` : `ทำเครื่องหมาย ${task.title} ว่าเสร็จแล้ว`}
                    disabled={busy || Boolean(completingTaskId) || completed}
                    onPress={() => onCompleteTask(message.id, task)}
                    style={({pressed}) => [
                      local.pendingTaskButton,
                      completed && local.pendingTaskButtonDone,
                      pressed && local.pressed,
                      (busy || (Boolean(completingTaskId) && !completing) || completing) && local.disabled,
                    ]}>
                    {completing ? <ActivityIndicator color="#ffffff" size="small" /> : <MaterialIcon color={completed ? '#5b7c57' : '#ffffff'} name="check" size={15} />}
                    <Text style={[local.pendingTaskButtonText, completed && local.pendingTaskButtonTextDone]}>{completed ? 'บันทึกแล้ว' : 'เสร็จแล้ว'}</Text>
                  </Touchable>
                </View>
              );
            })}
          </View>
        ) : null}
        {!isUser && message.suggestions?.length ? (
          <View style={local.suggestionList}>
            {message.suggestions.map((suggestion) => (
              <Touchable
                accessibilityLabel={`ถามต่อ: ${suggestion}`}
                disabled={busy}
                key={suggestion}
                onPress={() => onAsk(suggestion)}
                style={({pressed}) => [local.suggestionChip, pressed && local.pressed, busy && local.disabled]}>
                <Text style={local.suggestionText}>{suggestion}</Text>
                <MaterialIcon color="#668166" name="arrow_forward" size={14} />
              </Touchable>
            ))}
          </View>
        ) : null}
        {!isUser && message.id !== 'assistant-intro' ? (
          <View style={local.feedbackRow}>
            <Text style={local.feedbackPrompt}>คำตอบนี้ช่วยได้ไหม</Text>
            <Touchable
              accessibilityLabel={speaking ? 'หยุดอ่านคำตอบ' : 'อ่านคำตอบออกเสียง'}
              onPress={() => onSpeak(message)}
              style={[local.feedbackButton, speaking && local.feedbackButtonSpeaking]}>
              <MaterialIcon color={speaking ? '#ffffff' : '#668166'} name={speaking ? 'stop_circle' : 'volume_up'} size={16} />
            </Touchable>
            <Touchable
              accessibilityLabel="คำตอบมีประโยชน์"
              onPress={() => onFeedback(message, 'helpful')}
              style={[local.feedbackButton, message.feedback === 'helpful' && local.feedbackButtonActive]}>
              <MaterialIcon color={message.feedback === 'helpful' ? '#ffffff' : '#668166'} name="thumb_up" size={15} />
            </Touchable>
            <Touchable
              accessibilityLabel="คำตอบยังไม่ตรง"
              onPress={() => onFeedback(message, 'not_helpful')}
              style={[local.feedbackButton, message.feedback === 'not_helpful' && local.feedbackButtonNegative]}>
              <MaterialIcon color={message.feedback === 'not_helpful' ? '#ffffff' : '#9a6666'} name="thumb_down" size={15} />
            </Touchable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ActionCard({
  action,
  busy,
  saving,
  onConfirm,
  onReject,
}: {
  action: AssistantProposedAction;
  busy: boolean;
  saving: boolean;
  onConfirm: (updatedAction: AssistantProposedAction) => void;
  onReject: () => void;
}) {
  const done = action.status !== 'pending';
  // The "at least five minutes ahead" check below needs a clock. Reading
  // `Date.now()` from the component body makes the card's output depend on when
  // React happened to render it; this hook is the shared way to hold the time
  // as state, and a reading up to fifteen seconds old cannot change a
  // five-minute verdict.
  const now = useCurrentClock();
  const icon = action.entity === 'finance' ? 'payments' : action.entity === 'note' ? 'note_alt' : action.entity === 'memory' ? 'psychology' : action.entity === 'checklist' ? 'checklist' : 'event';
  const scheduleTimeZone = action.entity === 'schedule' ? validTimeZone(action.payload.generatedForTimeZone) : THAI_TIME_ZONE;
  const initialScheduleInput = action.entity === 'schedule' ? assistantLocalInput(action.payload.startAt, scheduleTimeZone) : '';
  const [dateDraft, setDateDraft] = useState(initialScheduleInput.slice(0, 10));
  const [durationDraft, setDurationDraft] = useState(action.entity === 'schedule' ? String(action.payload.estimatedDurationMinutes ?? Math.max(15, Math.round(((action.payload.endAt ? new Date(action.payload.endAt).getTime() : new Date(action.payload.startAt).getTime() + 3_600_000) - new Date(action.payload.startAt).getTime()) / 60_000))) : '60');
  const [editError, setEditError] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<'date' | 'time' | null>(null);
  const [timeDraft, setTimeDraft] = useState(initialScheduleInput.slice(11, 16));
  // Native picker reads device-local calendar fields, not an absolute Bangkok instant.
  // Conversion to the schedule time zone happens only when confirming below.
  const localPickerDate = new Date(`${dateDraft}T${timeDraft}:00`);
  const pickerValue = Number.isNaN(localPickerDate.getTime()) ? new Date() : localPickerDate;
  const durationOptions = [30, 45, 60, 90, 120];

  const selectPickerValue = (selectedDate: Date) => {
    if (pickerTarget === 'date') {
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      setDateDraft(`${year}-${month}-${day}`);
    } else if (pickerTarget === 'time') {
      setTimeDraft(`${String(selectedDate.getHours()).padStart(2, '0')}:${String(selectedDate.getMinutes()).padStart(2, '0')}`);
    }
    setEditError('');
    setPickerTarget(null);
  };

  const editedAction = (): AssistantProposedAction | null => {
    if (action.entity !== 'schedule') return action;
    const originalDuration = action.payload.estimatedDurationMinutes ?? Math.max(15, Math.round((new Date(action.payload.endAt ?? action.payload.startAt).getTime() - new Date(action.payload.startAt).getTime()) / 60000));
    if (dateDraft === initialScheduleInput.slice(0, 10) && timeDraft === initialScheduleInput.slice(11, 16) && Number(durationDraft) === originalDuration) return action;
    const startAt = parseAssistantLocalInput(`${dateDraft} ${timeDraft}`, scheduleTimeZone);
    const durationMinutes = Number(durationDraft);
    if (!startAt) {
      setEditError('กรุณาระบุวันที่และเวลาให้ถูกต้อง');
      return null;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 720) {
      setEditError('ระยะเวลาต้องอยู่ระหว่าง 15–720 นาที');
      return null;
    }
    if (startAt.getTime() < now + 5 * 60_000) {
      setEditError('กรุณาเลือกเวลาในอนาคตอย่างน้อย 5 นาที');
      return null;
    }
    setEditError('');
    return {
      ...action,
      payload: {
        ...action.payload,
        dateLocked: true,
        endAt: new Date(startAt.getTime() + durationMinutes * 60_000).toISOString(),
        estimatedDurationMinutes: durationMinutes,
        generatedForTimeZone: scheduleTimeZone,
        startAt: startAt.toISOString(),
        userSelectedTime: true,
      },
    };
  };

  const previewStart = action.entity === 'schedule'
    ? parseAssistantLocalInput(`${dateDraft} ${timeDraft}`, scheduleTimeZone) : null;
  const previewDuration = Number(durationDraft);
  const rows = actionDetails(action.entity === 'schedule' && previewStart && Number.isInteger(previewDuration) && previewDuration >= 15 && previewDuration <= 720
    ? {...action, payload: {...action.payload, startAt: previewStart.toISOString(), endAt: new Date(previewStart.getTime() + previewDuration * 60_000).toISOString(), estimatedDurationMinutes: previewDuration}}
    : action);
  const confirm = () => {
    const nextAction = editedAction();
    if (nextAction) onConfirm(nextAction);
  };
  return (
    <Card colors={['#ffffff', '#f6faf3']} style={local.actionCard}>
      <View style={local.actionHeader}>
        <View style={local.actionIcon}>
          <MaterialIcon color="#5d8059" name={icon} size={20} />
        </View>
        <View style={{flex: 1}}>
          <Text style={userStyles.cardTitle}>ยืนยันก่อนบันทึก</Text>
          <Text style={userStyles.bodyText}>{action.summary}</Text>
        </View>
      </View>
      <View style={local.detailBox}>
        {rows.map(([label, value]) => (
          <View key={label} style={local.detailRow}>
            <Text style={local.detailLabel}>{label}</Text>
            <Text style={local.detailValue}>{value}</Text>
          </View>
        ))}
      </View>
      {!done && action.entity === 'schedule' ? (
        <View style={local.actionEditorWrap}>
          <Touchable
            accessibilityLabel="แก้ไขวันที่ เวลา และระยะเวลาก่อนบันทึก"
            disabled={busy}
            onPress={() => { setEditorOpen((value) => !value); setEditError(''); }}
            style={[local.actionEditorToggle, editorOpen && local.actionEditorToggleActive, busy && local.disabled]}>
            <MaterialIcon color={editorOpen ? '#ffffff' : '#5d8059'} name="edit_calendar" size={18} />
            <Text style={[local.actionEditorToggleText, editorOpen && local.actionEditorToggleTextActive]}>{editorOpen ? 'กำลังใช้เวลาที่คุณกำหนด' : 'แก้ไขวัน เวลา และระยะเวลาเอง'}</Text>
            <MaterialIcon color={editorOpen ? '#ffffff' : '#71806d'} name={editorOpen ? 'expand_less' : 'expand_more'} size={18} />
          </Touchable>
          {editorOpen ? (
            <View style={local.actionEditorPanel}>
              <View style={local.actionEditorRow}>
                <View style={local.actionEditorField}>
                  <Text style={local.actionEditorLabel}>วันที่</Text>
                  <Touchable accessibilityLabel="เลือกวันที่" onPress={() => setPickerTarget('date')} style={local.actionPickerButton}>
                    <MaterialIcon color="#5d8059" name="calendar_month" size={18} />
                    <Text style={local.actionPickerValue}>{dateDraft}</Text>
                    <MaterialIcon color="#879383" name="expand_more" size={17} />
                  </Touchable>
                </View>
                <View style={local.actionEditorFieldSmall}>
                  <Text style={local.actionEditorLabel}>เวลา</Text>
                  <Touchable accessibilityLabel="เลือกชั่วโมงและนาที" onPress={() => setPickerTarget('time')} style={local.actionPickerButton}>
                    <MaterialIcon color="#5d8059" name="schedule" size={18} />
                    <Text style={local.actionPickerValue}>{timeDraft}</Text>
                    <MaterialIcon color="#879383" name="expand_more" size={17} />
                  </Touchable>
                </View>
              </View>
              {pickerTarget ? <NativeDateTimePicker
                accentColor="#5d8059"
                is24Hour
                mode={pickerTarget}
                onDismiss={() => setPickerTarget(null)}
                onValueChange={(_, selectedDate) => selectPickerValue(selectedDate)}
                presentation="dialog"
                value={pickerValue}
              /> : null}
              <View style={local.actionEditorDurationRow}>
                <View style={{flex: 1}}>
                  <Text style={local.actionEditorLabel}>ระยะเวลา (นาที)</Text>
                  <TextInput keyboardType="number-pad" onChangeText={setDurationDraft} placeholder="60" placeholderTextColor="#9aa395" style={local.actionEditorInput} value={durationDraft} />
                </View>
                <View style={local.actionEditorHintBadge}><MaterialIcon color="#5d8059" name="verified" size={15} /><Text style={local.actionEditorHintBadgeText}>ตรวจช่วงว่างก่อนบันทึก</Text></View>
              </View>
              <View style={local.actionDurationOptions}>{durationOptions.map((minutes) => <Touchable key={minutes} onPress={() => setDurationDraft(String(minutes))} style={[local.actionDurationChip, durationDraft === String(minutes) && local.actionDurationChipActive]}><Text style={[local.actionDurationChipText, durationDraft === String(minutes) && local.actionDurationChipTextActive]}>{minutes < 60 ? `${minutes} นาที` : `${minutes / 60} ชม.`}</Text></Touchable>)}</View>
              {editError ? <Text style={local.actionEditorError}>{editError}</Text> : <Text style={local.actionEditorHint}>เวลาที่คุณเลือกจะมีสิทธิ์เหนือคำแนะนำของ AI และระบบจะตรวจสอบอีกครั้งก่อนบันทึก</Text>}
            </View>
          ) : null}
        </View>
      ) : null}
      {done ? <StatusPill status={action.status} /> : (
        <View style={local.confirmRow}>
          <Touchable disabled={busy} onPress={onReject} style={[local.secondaryButton, busy && local.disabled]}>
            <Text style={local.secondaryButtonText}>ไม่บันทึก</Text>
          </Touchable>
          <Touchable disabled={busy} onPress={confirm} style={[local.actionConfirmButton, busy && local.disabled]}>
            {saving ? <ActivityIndicator color="#ffffff" size="small" /> : <MaterialIcon color="#ffffff" name="check" size={19} />}
            <Text style={local.actionConfirmText}>{saving ? 'กำลังบันทึก...' : 'ยืนยันบันทึก'}</Text>
          </Touchable>
        </View>
      )}
    </Card>
  );
}

function StatusPill({status}: {status: ProposedActionStatus}) {
  const confirmed = status === 'confirmed';
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(progress, {bounciness: 14, speed: 15, toValue: 1, useNativeDriver: true}).start();
  }, [progress]);
  return (
    <Animated.View style={[local.statusPill, confirmed ? local.statusConfirmed : local.statusRejected, {opacity: progress, transform: [{scale: progress}]}]}>
      <View style={[local.statusIcon, confirmed ? local.statusIconConfirmed : local.statusIconRejected]}><MaterialIcon color="#ffffff" name={confirmed ? 'check' : 'close'} size={16} /></View>
      <Text style={[local.statusText, confirmed ? local.statusTextConfirmed : local.statusTextRejected]}>
        {confirmed ? 'บันทึกแล้ว' : 'ยกเลิกแล้ว'}
      </Text>
    </Animated.View>
  );
}

const adaptiveCategoryLabels: Record<string, string> = {
  administration: 'งานทั่วไป',
  assignment: 'งานส่ง',
  exercise: 'ออกกำลังกาย',
  gaming: 'โหมดเล่นเกม',
  other: 'กิจกรรมยืดหยุ่น',
  personal_project: 'โปรเจกต์ส่วนตัว',
  programming: 'เขียนโปรแกรม',
  reading: 'อ่านหนังสือ',
  rest: 'พักผ่อน',
  shopping: 'ซื้อของ',
  study: 'เรียน/ทบทวน',
};

function adaptiveConfidenceLabel(value: number) {
  if (value >= .75) return 'มั่นใจสูง';
  if (value >= .5) return 'มั่นใจปานกลาง';
  if (value >= .3) return 'กำลังเรียนรู้';
  return 'ข้อมูลยังน้อย';
}

function InlineAdaptivePanel({
  busyKey,
  onAccept,
  onAlternative,
  onReject,
  suggestions,
}: {
  busyKey: string;
  onAccept: (suggestion: AdaptiveSuggestion) => void;
  onAlternative: (suggestion: AdaptiveSuggestion, startAt: string) => void;
  onReject: (suggestion: AdaptiveSuggestion) => void;
  suggestions: AdaptiveSuggestion[];
}) {
  if (!suggestions.length) return null;
  return <LinearGradient colors={['#f1f8ed', '#ffffff', '#f4f2fa']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={local.inlineAdaptivePanel}>
    <View style={local.inlineAdaptiveHeader}>
      <View style={local.inlineAdaptiveHeaderIcon}><MaterialIcon color="#ffffff" name="auto_awesome" size={19} /></View>
      <View style={{flex: 1}}><Text style={local.inlineAdaptiveHeading}>Adaptive ทำงานในแชตนี้</Text><Text style={local.inlineAdaptiveHint}>ตรวจและยืนยันได้ตรงนี้ ไม่ต้องเปลี่ยนหน้า</Text></View>
      <View style={local.inlineAdaptiveCount}><Text style={local.inlineAdaptiveCountText}>{suggestions.length}</Text></View>
    </View>
    {suggestions.map((suggestion) => {
      const timeZone = validTimeZone(suggestion.generatedForTimeZone);
      const loading = busyKey.endsWith(suggestion.id);
      return <View key={suggestion.id} style={local.inlineAdaptiveCard}>
        <View style={local.inlineAdaptiveTitleRow}>
          <View style={local.inlineAdaptiveCategory}><Text style={local.inlineAdaptiveCategoryText}>{adaptiveCategoryLabels[suggestion.activityCategory] ?? suggestion.activityCategory}</Text></View>
          <Text style={local.inlineAdaptiveConfidence}>{adaptiveConfidenceLabel(suggestion.confidence)} · {Math.round(suggestion.confidence * 100)}%</Text>
        </View>
        <Text style={local.inlineAdaptiveTitle}>{suggestion.taskTitle}</Text>
        <View style={local.inlineAdaptiveTimeRow}>
          <View style={{flex: 1}}><Text style={local.inlineAdaptiveTimeLabel}>เวลาเดิม</Text><Text style={local.inlineAdaptiveTimeValue}>{formatDate(suggestion.originalStartAt, timeZone)}</Text></View>
          <View style={local.inlineAdaptiveArrow}><MaterialIcon color="#5e805b" name="arrow_forward" size={17} /></View>
          <View style={{flex: 1}}><Text style={local.inlineAdaptiveTimeLabel}>เวลาที่แนะนำ</Text><Text style={local.inlineAdaptiveTimeValue}>{formatDate(suggestion.suggestedStartAt, timeZone)}</Text></View>
        </View>
        <Text style={local.inlineAdaptiveReason}>{suggestion.explanation}</Text>
        <Text style={local.inlineAdaptiveLearning}>{suggestion.observationCount > 0 ? `เรียนรู้จากพฤติกรรม ${suggestion.observationCount} ครั้ง` : 'ใช้ตารางจริงและค่าที่คุณตั้งไว้ ข้อมูลพฤติกรรมยังไม่พอสำหรับสรุปถาวร'}</Text>
        {suggestion.alternativeOptions?.length ? <View style={local.inlineAlternativeList}>{suggestion.alternativeOptions.slice(0, 2).map((option) => <Touchable disabled={Boolean(busyKey)} key={`${suggestion.id}-${option.startAt}`} onPress={() => onAlternative(suggestion, option.startAt)} style={({pressed}) => [local.inlineAlternativeButton, pressed && local.pressed, Boolean(busyKey) && local.disabled]}><MaterialIcon color="#5e7e5b" name="schedule" size={15} /><Text style={local.inlineAlternativeText}>{option.label || formatDate(option.startAt, timeZone)}</Text></Touchable>)}</View> : null}
        <View style={local.inlineAdaptiveActions}>
          <Touchable disabled={Boolean(busyKey)} onPress={() => onReject(suggestion)} style={[local.inlineRejectButton, Boolean(busyKey) && local.disabled]}><Text style={local.inlineRejectText}>ไม่ใช้เวลานี้</Text></Touchable>
          <Touchable disabled={Boolean(busyKey)} onPress={() => onAccept(suggestion)} style={[local.inlineAcceptButton, Boolean(busyKey) && local.disabled]}>{loading ? <ActivityIndicator color="#ffffff" size="small" /> : <MaterialIcon color="#ffffff" name="check" size={18} />}<Text style={local.inlineAcceptText}>{loading ? 'กำลังตรวจ...' : 'ยืนยันใช้เวลานี้'}</Text></Touchable>
        </View>
      </View>;
    })}
  </LinearGradient>;
}

type InsightItem = {icon: string; subtitle: string; title: string};
type WeeklyInsightData = {activities?: unknown; schedules?: unknown};

function insightRecords(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}

function insightTitle(item: Record<string, unknown>) {
  const title = item.title ?? item.courseName ?? item.courseCode;
  return typeof title === 'string' && title.trim() ? title : 'รายการในตาราง';
}

function insightDate(item: Record<string, unknown>) {
  const value = item.startAt;
  const date = new Date(typeof value === 'string' ? value : '');
  return Number.isNaN(date.getTime()) ? null : date;
}

// Added for AI Assistant insights: present seven-day workload, behavior, and focus using existing calendar data only.
function AssistantInsights({adaptiveDashboard, data, onAsk, uid}: {adaptiveDashboard: AdaptiveDashboard | null; data: WeeklyInsightData | null; onAsk: (prompt: string) => void; uid: string}) {
  // The declared window is the weaker fallback, so it is loaded here rather
  // than derived from `data`: it is a preference, not part of the week's records.
  const [sleepBaselineHours, setSleepBaselineHours] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void loadSleepBaseline(uid)
      .then((baseline) => { if (active) setSleepBaselineHours(baselineNightHours(baseline)); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [uid]);
  const insight = useMemo(() => {
    const schedules = insightRecords(data?.schedules);
    const activities = insightRecords(data?.activities);
    const all = [
      ...schedules.map((item) => ({date: insightDate(item), icon: 'calendar_month', kind: 'ตารางเรียน', title: insightTitle(item)})),
      ...activities.map((item) => ({date: insightDate(item), icon: 'task_alt', kind: 'กิจกรรม', title: insightTitle(item)})),
    ].sort((first, second) => (first.date?.getTime() ?? Number.MAX_SAFE_INTEGER) - (second.date?.getTime() ?? Number.MAX_SAFE_INTEGER));
    const morning = all.filter((item) => item.date && item.date.getHours() < 12).length;
    const afternoon = all.filter((item) => item.date && item.date.getHours() >= 12 && item.date.getHours() < 17).length;
    const evening = all.filter((item) => item.date && item.date.getHours() >= 17).length;
    const schedulePreferred = morning >= afternoon && morning >= evening ? 'ช่วงเช้า' : afternoon >= evening ? 'ช่วงบ่าย' : 'ช่วงเย็น';
    const learnedPattern = [...(adaptiveDashboard?.patterns ?? [])]
      .filter((pattern) => pattern.observationCount > 0)
      .sort((left, right) => right.confidenceScore - left.confidenceScore || right.observationCount - left.observationCount)[0];
    const learnedHour = learnedPattern?.preferredStartHour;
    const preferred = learnedHour === undefined
      ? schedulePreferred
      : learnedHour < 11 ? 'ช่วงเช้า' : learnedHour < 17 ? 'ช่วงบ่าย' : learnedHour < 21 ? 'ช่วงเย็น' : 'ช่วงกลางคืน';
    const focusMinutes = learnedPattern
      ? Math.max(15, Math.min(120, Math.round(learnedPattern.averageDurationMinutes / 5) * 5))
      : 35;
    const behaviorEvidence = learnedPattern
      ? `${adaptiveCategoryLabels[learnedPattern.activityCategory] ?? learnedPattern.activityCategory} · เรียนรู้จากผลลัพธ์จริง ${learnedPattern.observationCount} ครั้ง`
      : 'ยังมีข้อมูลผลลัพธ์ไม่พอ จึงใช้เฉพาะตาราง 7 วันและจะไม่สรุปเป็นนิสัยถาวร';
    const burnout = calculateBurnoutDynamicInsight({
      activities: activities as unknown as WithId<Activity>[],
      pendingTasks: activities.filter((item) => item.type === 'task') as unknown as WithId<Activity>[],
      schedules: schedules as unknown as WithId<Schedule>[],
      sleepBaselineHours,
      weekActivities: activities as unknown as WithId<Activity>[],
      weekSchedules: schedules as unknown as WithId<Schedule>[],
    });
    const workload = all.length;
    const risk = burnoutRiskBand(burnout.riskLevel).label;
    const sleepEvidence = burnout.sleepEvidenceSource === 'logged'
      ? `นอนจริงเฉลี่ย ${burnout.averageSleepHours ?? '-'} ชม. จาก ${burnout.sleepDataDays} คืนที่บันทึก`
      : burnout.sleepEvidenceSource === 'baseline'
        ? `ยังไม่มีบันทึกจริง ใช้ช่วงนอนปกติที่ตั้งไว้ ${burnout.averageSleepHours} ชม. เป็นค่าอ้างอิง`
        : 'ยังไม่มีข้อมูลการนอน จึงไม่คาดเดา';
    // One short fact per line instead of one " · "-joined sentence, so no
    // fragment has to share a wrapping line with the others. The old leading
    // "คะแนน N/100" is gone because RiskMeter's own scale caption renders the
    // same score directly below this block -- the number is still on screen.
    const riskFacts = [
      `เรียน/งาน ${burnout.busyHoursThisWeek} ชม.`,
      `งานค้าง ${burnout.pendingTaskCount}`,
      sleepEvidence,
    ];
    if (burnout.sleepDebtHours !== null && burnout.sleepDebtNights >= 3) {
      riskFacts.push(`นอนขาดสะสม ${burnout.sleepDebtHours} ชม.`);
    }
    if (burnout.studyWorkToSleepRatio !== null) {
      riskFacts.push(`สัดส่วนงานต่อการนอน ${burnout.studyWorkToSleepRatio}:1`);
    }
    const focus: InsightItem[] = all.slice(0, 3).map((item) => ({icon: item.icon, subtitle: item.kind, title: item.title}));
    if (!focus.length) focus.push(
      {icon: 'calendar_month', subtitle: 'เริ่มจากข้อมูลที่มี', title: 'เพิ่มตารางของสัปดาห์นี้'},
      {icon: 'task_alt', subtitle: 'ช่วยจัดลำดับให้ได้', title: 'บันทึกงานที่ต้องส่ง'},
      {icon: 'savings', subtitle: 'วางแผนง่ายขึ้น', title: 'กำหนดงบสำหรับสัปดาห์นี้'},
    );
    return {behaviorEvidence, focus, focusMinutes, preferred, risk, riskFacts, riskLevel: burnout.riskLevel, score: burnout.score, workload};
  }, [adaptiveDashboard?.patterns, data, sleepBaselineHours]);

  return <View style={local.insightSection}>
    <View style={local.insightHeader}><Text style={local.insightHeading}>วิเคราะห์ข้อมูล 7 วันที่ผ่านมา</Text><Text style={local.insightCount}>{insight.workload} รายการ</Text></View>
    <View style={local.insightDivider} />
    <View style={local.burnoutPanel}><View style={local.burnoutIcon}><MaterialIcon color="#8a8050" name="warning_amber" size={18} /></View><View style={{flex: 1}}><Text style={local.burnoutTitle}>ความเสี่ยงสภาวะหมดไฟ: {insight.risk}</Text>{insight.riskFacts.map((fact) => <Text key={fact} style={local.burnoutText}>{fact}</Text>)}<RiskMeter level={insight.riskLevel} score={insight.score} /></View></View>
    <View style={local.behaviorPanel}><View style={local.behaviorHeading}><View style={local.behaviorIcon}><MaterialIcon color="#668d65" name="schedule" size={18} /></View><View style={{flex: 1}}><Text style={local.behaviorTitle}>AI เรียนรู้พฤติกรรม</Text><Text style={local.behaviorText}>{insight.behaviorEvidence}</Text></View></View><View style={local.behaviorTiming}><View style={local.timingTile}><Text style={local.timingLabel}>ช่วงที่เหมาะ</Text><Text style={local.timingValue}>{insight.preferred}</Text></View><View style={local.timingTile}><Text style={local.timingLabel}>ระยะเวลาที่แนะนำ</Text><Text style={local.timingValue}>โฟกัส {insight.focusMinutes} นาที</Text></View></View><Touchable onPress={() => onAsk(`ช่วยจัดช่วงโฟกัส ${insight.focusMinutes} นาทีให้เหมาะกับตารางของฉัน`)} style={local.behaviorAction}><MaterialIcon color="#fff" name="check" size={17} /><Text style={local.behaviorActionText}>ใช้แผน Adaptive ในแชตนี้</Text></Touchable></View>
    <View style={local.focusHeader}><Text style={local.focusHeading}>AI แนะนำให้โฟกัส</Text><Text style={local.focusCount}>{insight.focus.length} รายการ</Text></View>
    <View style={local.focusList}>{insight.focus.map((item, index) => <Touchable key={`${item.title}-${index}`} onPress={() => onAsk(`ช่วยวางแผน ${item.title}`)} style={local.focusItem}><View style={local.focusIcon}><MaterialIcon color="#678266" name={item.icon} size={17} /></View><View style={{flex: 1}}><Text numberOfLines={1} style={local.focusItemTitle}>{item.title}</Text><Text numberOfLines={1} style={local.focusText}>{item.subtitle}</Text></View><MaterialIcon color="#95a18f" name="chevron_right" size={18} /></Touchable>)}</View>
  </View>;
}

// Refactored UI: derive focus suggestions from existing proposed actions, without new data sources.
function FocusSuggestions({messages}: {messages: AssistantChatMessage[]}) {
  const suggestions = messages.filter((message) => message.role === 'assistant' && message.proposedAction && ['activity', 'checklist'].includes(message.proposedAction.entity));
  if (!suggestions.length) return null;
  return <View style={local.focusSection}>
    <Text style={local.focusHeading}>AI แนะนำให้โฟกัส</Text>
    {suggestions.map((message) => <View key={`focus-${message.id}`} style={local.focusItem}><View style={local.focusIcon}><MaterialIcon color="#678266" name="task_alt" size={17} /></View><Text numberOfLines={2} style={local.focusText}>{message.proposedAction?.summary}</Text></View>)}
  </View>;
}

const ADAPTIVE_AI_SHORTCUT = 'smartlife_adaptive_ai';

const shortcuts = [
  ['calendar_month', 'ตารางวันนี้', 'ดูงานเรียงลำดับ', 'smartlife_notifications_schedule'],
  ['check_box', 'งานค้าง', 'เรียงความสำคัญ', 'smartlife_notifications_urgent'],
  ['account_balance_wallet', 'งบสัปดาห์', 'เช็กยอดใช้และลิมิต 80%', 'smartlife_notifications_finance'],
  ['auto_awesome', 'Adaptive AI', 'จัดงานลงเวลาว่าง', ADAPTIVE_AI_SHORTCUT],
];

type QuickAddCategoryId = 'adaptive' | 'finance' | 'note' | 'ocr' | 'task' | 'time' | 'wellbeing';
type QuickAddSuggestion = {action?: 'activate_adaptive'; detail: string; icon: string; prompt: string; title: string};

const defaultOcrShortcuts: QuickAddSuggestion[] = [
  {detail: 'ดูข้อมูลจากสลิปหรือใบเสร็จล่าสุด', icon: 'receipt_long', prompt: 'สรุปข้อมูลจาก OCR ล่าสุดให้หน่อย', title: 'ดู OCR ล่าสุด'},
  {detail: 'แยกปี พ.ศ. และ ค.ศ. ให้ถูกต้อง', icon: 'event_available', prompt: 'ตรวจวันและปีจาก OCR ว่าเป็น พ.ศ. หรือ ค.ศ.', title: 'ตรวจวันและปี'},
  {detail: 'ค้นจากข้อมูล OCR ช่วงล่าสุด ไม่จำกัดวันเดียว', icon: 'history', prompt: 'แสดงข้อมูล OCR ที่บันทึกไว้ช่วงล่าสุด', title: 'ดู OCR ช่วงล่าสุด'},
  {detail: 'ชี้ข้อมูลที่ไม่แน่ใจเพื่อให้ตรวจแก้', icon: 'fact_check', prompt: 'ตรวจข้อมูล OCR ที่ยังไม่แน่ใจและบอกจุดที่ควรแก้', title: 'ตรวจจุดไม่แน่ใจ'},
];

function ocrShortcutsKey(uid: string) {
  return `smartlife:assistant:ocr-shortcuts:${uid}`;
}

function isAdaptiveSchedulingCommand(value: string) {
  return /(หาเวลา(?:ให้|ทำ|อ่าน)|(?:ย้าย|เลื่อน|จัด|วาง|แบ่ง|แทรก).*(?:งาน|การบ้าน|อ่าน|เรียน|ออกกำลัง)|(?:จัด|วาง|เลื่อน|ย้าย|นัด).{0,100}(?:ช่วง(?:เช้า|สาย|บ่าย|เย็น|กลางคืน)|วัน(?:นี้|พรุ่งนี้|มะรืน|จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์)|เวลา\s*\d{1,2}(?::\d{2})?|\d{1,2}\s*(?:โมง|ทุ่ม))|(?:งานค้าง|งานที่ยังไม่เสร็จ).*(?:ลง|ใส่|ย้าย|จัด).*(?:เวลาว่าง|ตาราง)|ตาราง.*(?:เบา|แน่น|ล้น)|(?:ช่วย)?จัด.*สัปดาห์|สัปดาห์.*(?:จัด|วาง|ปรับ)|สมดุล.*สัปดาห์|plan my|find time|move my unfinished|make tomorrow less busy|when am i most productive|productive|ประสิทธิภาพ|ช่วงไหน.*(?:ทำงาน|อ่าน|เรียน).*ดี|อย่า.*(?:จัด|วาง)|ไม่.*(?:จัด|วาง).*(?:เช้า|บ่าย|เย็น|ดึก)|do not schedule|always schedule|จัด.*(?:อ่าน|เรียน|ออกกำลัง|เขียนโปรแกรม).*(?:เช้า|บ่าย|เย็น|ดึก)|why.*move|ทำไม.*ย้าย)/i.test(value);
}

function adaptiveProposalAction(proposal: AdaptiveProposedActivity): AssistantProposedAction {
  return {
    entity: 'schedule',
    id: messageId('adaptive-action'),
    payload: {
      aiReason: proposal.explanation,
      aiScheduled: true,
      allowAiReschedule: !proposal.dateLocked,
      category: proposal.activityCategory,
      dateLocked: proposal.dateLocked,
      deadline: proposal.deadline,
      endAt: proposal.endAt,
      estimatedDurationMinutes: proposal.durationMinutes,
      generatedForTimeZone: proposal.generatedForTimeZone,
      isFlexible: true,
      location: '',
      startAt: proposal.startAt,
      title: proposal.title,
      type: 'task',
    },
    status: 'pending',
    summary: proposal.dateLocked
      ? `เพิ่มนัดหมาย "${proposal.title}" ในวันที่กำหนด โดยเลือกช่วงว่างที่ AI ตรวจแล้ว`
      : `เพิ่มงานยืดหยุ่น "${proposal.title}" ลงช่วงว่างที่ AI ตรวจแล้ว`,
    type: 'create',
  };
}

function parseOcrShortcuts(raw: string | null): QuickAddSuggestion[] {
  if (!raw) return defaultOcrShortcuts;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultOcrShortcuts;
    const shortcuts = parsed.slice(0, 4).flatMap((item): QuickAddSuggestion[] => {
      if (!item || typeof item !== 'object') return [];
      const title = String(item.title ?? '').trim().slice(0, 40);
      const prompt = String(item.prompt ?? '').trim().slice(0, 240);
      if (!title || !prompt) return [];
      return [{detail: String(item.detail ?? prompt).trim().slice(0, 90), icon: 'document_scanner', prompt, title}];
    });
    return shortcuts.length ? shortcuts : defaultOcrShortcuts;
  } catch {
    return defaultOcrShortcuts;
  }
}

const quickAddCategories: {
  createLabel: string;
  createPrompt: string;
  detail: string;
  icon: string;
  id: QuickAddCategoryId;
  suggestions: QuickAddSuggestion[];
  title: string;
}[] = [
  {
    createLabel: 'เพิ่มกิจกรรมหรือนัดหมายใหม่',
    createPrompt: 'เพิ่มนัดหมาย ',
    detail: 'ตารางเรียน สอบ นัดหมาย และเวลาว่าง',
    icon: 'event',
    id: 'time',
    suggestions: [
      {detail: 'ตรวจจากตารางของวันนี้', icon: 'school', prompt: 'วันนี้มีเรียนกี่โมงบ้าง', title: 'วันนี้เรียนกี่โมง'},
      {detail: 'ดูวันสอบทั้งหมดที่บันทึกไว้', icon: 'quiz', prompt: 'ฉันมีสอบวันไหนบ้าง', title: 'สอบวันไหน'},
      {detail: 'ค้นหาช่วงว่างจากตารางจริง', icon: 'schedule', prompt: 'วันนี้ฉันว่างช่วงไหนบ้าง', title: 'วันนี้ว่างตอนไหน'},
      {detail: 'แนะนำวันและเวลาที่เหมาะสม', icon: 'menu_book', prompt: 'ควรอ่านหนังสือวันไหนและกี่โมง', title: 'ควรอ่านหนังสือเมื่อไหร่'},
    ],
    title: 'เวลา',
  },
  {
    createLabel: 'เพิ่มงานใหม่',
    createPrompt: 'เพิ่มงาน ',
    detail: 'งานค้าง กำหนดส่ง และการจัดลำดับ',
    icon: 'checklist',
    id: 'task',
    suggestions: [
      {detail: 'แสดงงานที่ยังไม่เสร็จ', icon: 'pending_actions', prompt: 'ตอนนี้มีงานค้างอะไรบ้าง', title: 'งานค้างมีอะไรบ้าง'},
      {detail: 'เรียงจากความสำคัญและกำหนดส่ง', icon: 'low_priority', prompt: 'ควรทำงานอะไรก่อน', title: 'ควรทำอะไรก่อน'},
      {detail: 'ตรวจงานที่ใกล้ถึงกำหนด', icon: 'event_upcoming', prompt: 'งานไหนใกล้ถึงกำหนดส่งที่สุด', title: 'งานไหนใกล้ส่ง'},
      {detail: 'ช่วยแบ่งงานเป็นช่วงที่ทำได้จริง', icon: 'view_timeline', prompt: 'ช่วยวางแผนงานของสัปดาห์นี้', title: 'วางแผนงานสัปดาห์นี้'},
    ],
    title: 'งาน',
  },
  {
    createLabel: 'เพิ่มรายรับหรือรายจ่าย',
    createPrompt: 'จ่าย ',
    detail: 'ยอดคงเหลือ งบประมาณ และรายการเงิน',
    icon: 'payments',
    id: 'finance',
    suggestions: [
      {detail: 'ดูจากรายการของเดือนนี้', icon: 'account_balance_wallet', prompt: 'เดือนนี้ฉันเหลือเงินเท่าไหร่', title: 'เงินเหลือเท่าไหร่'},
      {detail: 'ดูยอดใช้และสัดส่วนของสัปดาห์', icon: 'date_range', prompt: 'สรุปงบสัปดาห์นี้ให้หน่อย', title: 'งบสัปดาห์เป็นอย่างไร'},
      {detail: 'เตือนเมื่อใช้ถึง 80% ของกรอบ', icon: 'savings', prompt: 'สัปดาห์นี้ใช้งบไปกี่เปอร์เซ็นต์แล้ว', title: 'ใกล้ถึง 80% หรือยัง'},
      {detail: 'แนะนำจากงบและจำนวนวันที่เหลือ', icon: 'restaurant', prompt: 'วันนี้ควรตั้งงบค่าอาหารเท่าไหร่', title: 'ค่าอาหารควรเท่าไหร่'},
    ],
    title: 'การเงิน',
  },
  {
    createLabel: 'เพิ่มเวลานอนในแพลนเนอร์',
    createPrompt: 'เพิ่มกิจกรรม นอน เวลา ',
    detail: 'ความเสี่ยงหมดไฟ การพัก และข้อมูลการนอน',
    icon: 'self_improvement',
    id: 'wellbeing',
    suggestions: [
      {detail: 'คำนวณจากตาราง งานค้าง และการนอนจริง', icon: 'monitor_heart', prompt: 'ประเมินความเสี่ยงหมดไฟจากข้อมูลของฉัน', title: 'เช็กความเสี่ยงหมดไฟ'},
      {detail: 'ดูหลักฐานที่ถูกนำไปคิดคะแนน', icon: 'fact_check', prompt: 'คะแนนหมดไฟของฉันคิดจากข้อมูลอะไรบ้าง', title: 'ดูเหตุผลของคะแนน'},
      {detail: 'เลือกสิ่งที่เหมาะกับช่องว่างจริง', icon: 'hourglass_bottom', prompt: 'ตอนนี้มีเวลาว่างเท่าไหร่และควรพักหรือทำอะไร', title: 'ช่วงว่างควรทำอะไร'},
      {detail: 'ตรวจเฉพาะกิจกรรมการนอนที่บันทึกไว้', icon: 'bedtime', prompt: 'สัปดาห์นี้มีข้อมูลการนอนของฉันกี่คืน', title: 'ดูข้อมูลการนอน'},
    ],
    title: 'สุขภาพใจ',
  },
  {
    createLabel: 'จดโน้ตใหม่',
    createPrompt: 'จดโน้ต ',
    detail: 'โน้ตการเรียน งาน ไอเดีย และบันทึก',
    icon: 'note_add',
    id: 'note',
    suggestions: [
      {detail: 'แสดงโน้ตที่บันทึกล่าสุด', icon: 'notes', prompt: 'ฉันมีโน้ตอะไรบ้าง', title: 'มีโน้ตอะไรบ้าง'},
      {detail: 'ค้นหาเฉพาะหมวดการเรียน', icon: 'school', prompt: 'มีโน้ตการเรียนอะไรบ้าง', title: 'ดูโน้ตการเรียน'},
      {detail: 'ค้นหาเฉพาะหมวดงาน', icon: 'task', prompt: 'มีโน้ตงานอะไรบ้าง', title: 'ดูโน้ตงาน'},
      {detail: 'ให้ AI ช่วยเลือกสิ่งที่ควรทบทวน', icon: 'auto_awesome', prompt: 'จากโน้ตควรทบทวนเรื่องอะไรก่อน', title: 'ควรทบทวนอะไร'},
    ],
    title: 'โน้ต',
  },
  {
    createLabel: 'เปิด Adaptive AI',
    createPrompt: 'เปิด Adaptive AI และช่วยจัดงานค้างลงในเวลาว่างตั้งแต่ตอนนี้',
    detail: 'จัดเวลาว่าง วันนี้ ทั้งสัปดาห์ และเรียนรู้พฤติกรรม',
    icon: 'auto_awesome',
    id: 'adaptive',
    suggestions: [
      {action: 'activate_adaptive', detail: 'ตรวจงานยืดหยุ่นและสร้างคำแนะนำในหน้าแชตนี้', icon: 'auto_awesome', prompt: 'เปิด Adaptive AI และช่วยจัดงานค้างลงในเวลาว่างตั้งแต่ตอนนี้', title: 'จัดงานลงเวลาว่าง'},
      {detail: 'ลดความแน่นของวันนี้โดยไม่ชนรายการที่ล็อกไว้', icon: 'today', prompt: 'ช่วยปรับตารางวันนี้ให้สมดุลและสร้างตัวเลือกให้ยืนยันในแชตนี้', title: 'ปรับตารางวันนี้'},
      {detail: 'กระจายงานยืดหยุ่นตลอดสัปดาห์ตามกำหนดส่ง', icon: 'date_range', prompt: 'ช่วยจัดทั้งสัปดาห์ให้สมดุลและสร้างตัวเลือกให้ยืนยันในแชตนี้', title: 'จัดทั้งสัปดาห์'},
      {detail: 'สรุปช่วงที่ทำสำเร็จจริงจากประวัติของฉัน', icon: 'psychology', prompt: 'จากพฤติกรรมจริง ช่วงไหนฉันทำกิจกรรมสำเร็จได้ดีที่สุด', title: 'ดูสิ่งที่ AI เรียนรู้'},
    ],
    title: 'Adaptive',
  },
  {
    createLabel: 'ตั้งค่าคำถามลัด OCR',
    createPrompt: '',
    detail: 'สลิป ใบเสร็จ วันเวลา และข้อมูลสแกนล่าสุด',
    icon: 'document_scanner',
    id: 'ocr',
    suggestions: defaultOcrShortcuts,
    title: 'OCR',
  },
];

// Refactored UI: these use the existing message pipeline instead of adding a second data flow.
const shortcutPrompts: Record<string, string> = {
  smartlife_notifications_ai: 'ช่วยแนะนำเวลาอ่านหนังสือวันนี้',
  smartlife_notifications_finance: 'สรุปงบสัปดาห์นี้ให้หน่อย',
  smartlife_notifications_schedule: 'วันนี้มีตารางอะไรบ้าง',
  smartlife_notifications_urgent: 'มีงานค้างอะไรบ้าง',
};

export default function AssistantScreen({autoAsk, autoListen, uid, onNavigate}: {autoAsk?: string; autoListen?: boolean; page: string; uid: string; onNavigate: UserNavigate}) {
  const {maybeStartTour} = useTour();
  const {ref: newChatRef, onLayout: newChatOnLayout} = useTourTarget('assistant', 'new-chat');
  const {ref: composerRef, onLayout: composerOnLayout} = useTourTarget('assistant', 'composer');
  useEffect(() => {
    maybeStartTour('assistant');
  }, [maybeStartTour]);
  const autoScrollPendingRef = useRef(true);
  const chatScrollRef = useRef<ScrollView>(null);
  const cloudWriteQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const scrollToBottomVisibleRef = useRef(false);
  const speechBaseInputRef = useRef('');
  const browserSpeechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  // Set when this browser exposes SpeechRecognition but its speech service is
  // unusable (offline recogniser, blocked Google endpoint). The next mic press
  // then records audio for Gemini instead of failing the same way again.
  const browserSpeechUnusableRef = useRef(false);
  const browserMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const browserMediaStreamRef = useRef<MediaStream | null>(null);
  const browserVoiceChunksRef = useRef<Blob[]>([]);
  const browserVoiceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const temporaryChatRef = useRef(false);
  const retryConfirmActionRef = useRef<{action: AssistantProposedAction; targetMessageId: string} | null>(null);
  const confirmActionInFlightRef = useRef(false);
  const adaptiveActivationInFlightRef = useRef(false);
  const inlineAdaptiveActionInFlightRef = useRef(false);
  const retryInlineAdaptiveActionRef = useRef<{action: () => Promise<unknown>; key: string; successMessage: string; title: string} | null>(null);
  const [busy, setBusy] = useState(false);
  const [busySeconds, setBusySeconds] = useState(0);
  // Nothing in the assistant pipeline is abortable -- the callable keeps
  // running whatever the user does -- so "หยุด" works by ticket instead. Every
  // request takes one; stopping tears it up; a request whose ticket is gone is
  // not allowed to write into the chat. The screen frees up straight away and
  // the answer that eventually lands is dropped rather than appearing on top of
  // whatever the user moved on to.
  const replyTicket = useRef(0);
  const beginReply = () => {
    setBusySeconds(0);
    setBusy(true);
    return ++replyTicket.current;
  };
  const stopReply = () => {
    replyTicket.current += 1;
    setBusy(false);
    showToast('หยุดรอคำตอบแล้ว', 'คำตอบที่ค้างอยู่จะไม่ถูกนำมาแสดง ถามใหม่ได้เลย', 'info');
  };
  // The counter is zeroed by whoever starts a request, not by this effect:
  // setting state from an effect body only to undo the previous render is the
  // cascading-render shape React asks us to avoid, and the start of a request
  // is the honest place for "the clock starts now" to live anyway.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const timer = setInterval(() => setBusySeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const [completingTaskId, setCompletingTaskId] = useState('');
  const [adaptiveActivationStatus, setAdaptiveActivationStatus] = useState<AsyncActionStatus>('idle');
  const [adaptiveActivationError, setAdaptiveActivationError] = useState('');
  const [confirmationActionStatus, setConfirmationActionStatus] = useState<AsyncActionStatus>('idle');
  const [confirmationActionError, setConfirmationActionError] = useState('');
  const [pendingScheduleConflict, setPendingScheduleConflict] = useState<{action: Extract<AssistantProposedAction, {entity: 'schedule'}>; conflicts: ScheduleConflict[]; targetMessageId: string} | null>(null);
  const [pendingNavigationPage, setPendingNavigationPage] = useState('');
  const [savingActionId, setSavingActionId] = useState('');
  const [inlineAdaptiveBusyKey, setInlineAdaptiveBusyKey] = useState('');
  const [inlineAdaptiveError, setInlineAdaptiveError] = useState('');
  const [inlineAdaptiveFeedbackMessage, setInlineAdaptiveFeedbackMessage] = useState('');
  const [inlineAdaptiveFeedbackStatus, setInlineAdaptiveFeedbackStatus] = useState<AsyncActionStatus>('idle');
  const [inlineAdaptiveFeedbackTitle, setInlineAdaptiveFeedbackTitle] = useState('');
  const [inlineAdaptiveSuggestions, setInlineAdaptiveSuggestions] = useState<AdaptiveSuggestion[]>([]);
  const [chatHistory, setChatHistory] = useState<AssistantConversationSummary[]>([]);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState<AssistantConversationSummary | null>(null);
  // The Adaptive preference gate is awaited mid-conversation, so the dialog has
  // to hand its answer back to that `await`. `Alert.alert` could resolve from a
  // button callback; on react-native-web it resolved nothing at all, because
  // the alert never appeared -- the await simply hung until the dismiss path
  // that also never ran. The resolver is parked in state instead.
  const [adaptivePreferenceGate, setAdaptivePreferenceGate] = useState<{resolve: (value: boolean) => void} | null>(null);
  const confirmAdaptivePreference = () => new Promise<boolean>((resolve) => setAdaptivePreferenceGate({resolve}));
  const answerAdaptivePreference = (value: boolean) => {
    adaptivePreferenceGate?.resolve(value);
    setAdaptivePreferenceGate(null);
  };
  const [conversationId, setConversationId] = useState(() => createAssistantConversationId());
  const [conversationState, setConversationState] = useState<AssistantConversationState>(() => createAssistantConversationState(conversationId));
  const [historyReady, setHistoryReady] = useState(false);
  const [historyOwnerUid, setHistoryOwnerUid] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [listening, setListening] = useState(false);
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [ocrShortcutDrafts, setOcrShortcutDrafts] = useState<QuickAddSuggestion[]>(defaultOcrShortcuts);
  const [ocrShortcutEditorOpen, setOcrShortcutEditorOpen] = useState(false);
  const [ocrShortcuts, setOcrShortcuts] = useState<QuickAddSuggestion[]>(defaultOcrShortcuts);
  const [quickAddCategory, setQuickAddCategory] = useState<QuickAddCategoryId | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [temporaryChat, setTemporaryChat] = useState(false);
  const [weeklyInsights, setWeeklyInsights] = useState<WeeklyInsightData | null>(null);
  const [adaptiveInsightDashboard, setAdaptiveInsightDashboard] = useState<AdaptiveDashboard | null>(null);
  const [messages, setMessages] = useState<AssistantChatMessage[]>(() => [assistantIntroMessage()]);
  const [speakingMessageId, setSpeakingMessageId] = useState('');
  // Refactored UI: the clean state remains visible until the user starts a conversation.
  const hasConversation = messages.some((message) => message.role === 'user');
  const visibleMessages = hasConversation ? messages.filter((message) => message.id !== 'assistant-intro') : [];
  const baseSelectedQuickAddCategory = quickAddCategories.find((category) => category.id === quickAddCategory) ?? null;
  const selectedQuickAddCategory = baseSelectedQuickAddCategory?.id === 'ocr'
    ? {...baseSelectedQuickAddCategory, suggestions: ocrShortcuts}
    : baseSelectedQuickAddCategory;

  useEffect(() => {
    temporaryChatRef.current = temporaryChat;
  }, [temporaryChat]);

  useEffect(() => {
    AsyncStorage.getItem(ocrShortcutsKey(uid))
      .then((value) => setOcrShortcuts(parseOcrShortcuts(value)))
      .catch(() => setOcrShortcuts(defaultOcrShortcuts));
  }, [uid]);

  useEffect(() => {
    let active = true;
    const today = thailandDateKey();

    async function loadHistoryAndBriefing() {
      setHistoryReady(false);
      setHistoryOwnerUid(null);
      setTemporaryChat(false);
      const [storedConversationId, lastBriefingDate] = await Promise.all([
        AsyncStorage.getItem(assistantActiveConversationKey(uid)),
        AsyncStorage.getItem(assistantBriefingKey(uid)),
      ]);
      const activeConversationId = storedConversationId?.startsWith('conversation-') && storedConversationId.length <= 80
        ? storedConversationId
        : createAssistantConversationId();
      const [storedMessages, storedState] = await Promise.all([
        AsyncStorage.getItem(assistantConversationHistoryKey(uid, activeConversationId)),
        AsyncStorage.getItem(assistantConversationStateKey(uid, activeConversationId)),
      ]);
      if (!active) return;

      const history = parseStoredMessages(storedMessages);
      const restoredState = parseAssistantConversationState(storedState, activeConversationId);
      setConversationId(activeConversationId);
      setConversationState(restoredState);
      autoScrollPendingRef.current = true;
      setMessages(history.length ? history : [assistantIntroMessage()]);
      setHistoryOwnerUid(uid);
      setHistoryReady(true);
      await AsyncStorage.setItem(assistantActiveConversationKey(uid), activeConversationId);

      if (lastBriefingDate === today) return;
      try {
        const reply = await buildAssistantReply(uid, 'สรุปวันนี้', [], {
          conversationId: activeConversationId,
          conversationState: restoredState,
        });
        if (!active) return;
        const briefingMessage: AssistantChatMessage = {
          content: reply.content,
          id: `briefing-${today}`,
          role: 'assistant',
          timestamp: nowIso(),
        };
        setMessages((current) => {
          if (current.some((message) => message.id === briefingMessage.id)) return current;
          return trimChatHistory([...current, briefingMessage]);
        });
        await AsyncStorage.setItem(assistantBriefingKey(uid), today);
      } catch {
        // Daily summary is helpful but should never block normal chat history.
      }
    }

    loadHistoryAndBriefing().catch(() => {
      if (!active) return;
      const fallbackConversationId = createAssistantConversationId();
      setConversationId(fallbackConversationId);
      setConversationState(createAssistantConversationState(fallbackConversationId));
      setMessages([assistantIntroMessage()]);
      setHistoryOwnerUid(uid);
      setHistoryReady(true);
    });
    return () => { active = false; };
  }, [uid]);

  useEffect(() => {
    let active = true;
    adaptiveScheduling.getDashboard()
      .then((value) => { if (active) setAdaptiveInsightDashboard(value); })
      .catch(() => { if (active) setAdaptiveInsightDashboard(null); });
    return () => { active = false; };
  }, [uid]);

  useEffect(() => {
    let active = true;
    loadLegacyPageData(uid, 'user/smartlife_calendar_week')
      .then((data) => { if (active) setWeeklyInsights(data as WeeklyInsightData); })
      .catch(() => { if (active) setWeeklyInsights({}); });
    return () => { active = false; };
  }, [uid]);

  useEffect(() => {
    if (!historyReady || historyOwnerUid !== uid || temporaryChat) return;
    AsyncStorage.multiSet([
      [assistantActiveConversationKey(uid), conversationId],
      [assistantConversationHistoryKey(uid, conversationId), JSON.stringify(trimChatHistory(messages))],
      [assistantConversationStateKey(uid, conversationId), JSON.stringify(conversationState)],
    ]).catch(() => undefined);
  }, [conversationId, conversationState, historyOwnerUid, historyReady, messages, temporaryChat, uid]);

  useEffect(() => {
    return () => {
      import('expo-speech').then((module) => module.stop()).catch(() => undefined);
      browserSpeechRecognitionRef.current?.abort();
      browserSpeechRecognitionRef.current = null;
      if (browserVoiceTimeoutRef.current) clearTimeout(browserVoiceTimeoutRef.current);
      browserVoiceTimeoutRef.current = null;
      if (browserMediaRecorderRef.current?.state === 'recording') browserMediaRecorderRef.current.stop();
      browserMediaRecorderRef.current = null;
      browserMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      browserMediaStreamRef.current = null;
      if (!NativeModules.Voice) return;
      import('@react-native-voice/voice').then((module) => {
        module.default.destroy().catch(() => undefined);
        module.default.removeAllListeners();
      }).catch(() => undefined);
    };
  }, []);

  const speakAssistantMessage = async (message: AssistantChatMessage) => {
    if (message.role !== 'assistant') return;
    let Speech: typeof import('expo-speech');
    try {
      Speech = await import('expo-speech');
    } catch {
      appendAssistant('เสียงตอบกลับพร้อมใช้งานแล้ว แต่ Development Build ตัวเก่ายังไม่มีโมดูลเสียง กรุณาติดตั้งบิลด์ใหม่หนึ่งครั้ง หลังจากนั้นการแก้หน้าจอทั่วไปอัปเดตผ่าน EAS Update ได้');
      return;
    }
    if (speakingMessageId === message.id) {
      await Speech.stop().catch(() => undefined);
      setSpeakingMessageId('');
      return;
    }
    await Speech.stop().catch(() => undefined);
    const spokenText = message.content.trim();
    if (!spokenText) return;
    const language = /[\u0E00-\u0E7F]/.test(spokenText) ? 'th-TH' : 'en-US';
    setSpeakingMessageId(message.id);
    Speech.speak(spokenText, {
      language,
      onDone: () => setSpeakingMessageId(''),
      onError: () => setSpeakingMessageId(''),
      onStopped: () => setSpeakingMessageId(''),
      pitch: 1,
      rate: .95,
    });
  };

  const persistMessage = (message: AssistantChatMessage, state: AssistantConversationState) => {
    if (temporaryChatRef.current || message.id === 'assistant-intro') return;
    cloudWriteQueueRef.current = cloudWriteQueueRef.current
      .then(() => saveAssistantMessage({conversationId, message, state, uid}))
      .catch((error) => console.warn('[SmartLife AI] Chat history save failed.', error));
  };

  const persistMessagePayload = (message: AssistantChatMessage) => {
    if (temporaryChatRef.current || message.id === 'assistant-intro') return;
    cloudWriteQueueRef.current = cloudWriteQueueRef.current
      .then(() => updateAssistantMessagePayload(uid, conversationId, message))
      .catch((error) => console.warn('[SmartLife AI] Chat message update failed.', error));
  };

  const scrollToLatest = (animated = true) => {
    autoScrollPendingRef.current = false;
    chatScrollRef.current?.scrollToEnd({animated});
    if (scrollToBottomVisibleRef.current) {
      scrollToBottomVisibleRef.current = false;
      setShowScrollToBottom(false);
    }
  };

  const queueScrollToLatest = () => {
    autoScrollPendingRef.current = true;
    requestAnimationFrame(() => chatScrollRef.current?.scrollToEnd({animated: true}));
  };

  const appendAssistant = (
    content: string,
    proposedAction?: AssistantProposedAction,
    metadata: Partial<Pick<AssistantReply, 'errorKind' | 'intent' | 'latencyMs' | 'pendingTaskShortcuts' | 'source' | 'suggestions'>> = {},
    id = messageId('assistant'),
    state = conversationState,
  ) => {
    const nextMessage: AssistantChatMessage = {
      content,
      id,
      proposedAction,
      role: 'assistant',
      timestamp: nowIso(),
      ...metadata,
    };
    setMessages((current) => trimChatHistory([...current, nextMessage]));
    persistMessage(nextMessage, state);
    queueScrollToLatest();
  };

  /**
   * `appendAssistant` for one request, silent once that request is stopped.
   * Handlers shadow the plain name with this, so every reply inside them is
   * covered without each call site having to remember. Replies the screen makes
   * on its own -- confirming a rejected card, say -- keep using the plain one,
   * because those are not a request and stopping must not swallow them.
   */
  const replyFor = (ticket: number) => (...args: Parameters<typeof appendAssistant>) => {
    if (ticket !== replyTicket.current) return;
    appendAssistant(...args);
  };

  const appendUser = (content: string, state = conversationState) => {
    const nextMessage: AssistantChatMessage = {content, id: messageId('user'), role: 'user', timestamp: nowIso()};
    setMessages((current) => trimChatHistory([...current, nextMessage]));
    persistMessage(nextMessage, state);
    queueScrollToLatest();
  };

  const updateActionStatus = (targetMessageId: string, status: ProposedActionStatus, updatedAction?: AssistantProposedAction) => {
    setMessages((current) => current.map((message) => {
      if (message.id !== targetMessageId || !message.proposedAction) return message;
      const updated = {...message, proposedAction: {...(updatedAction ?? message.proposedAction), status}} as AssistantChatMessage;
      persistMessagePayload(updated);
      return updated;
    }));
  };

  const updatePendingTaskShortcutStatus = (targetMessageId: string, taskId: string, status: AssistantPendingTaskShortcut['status']) => {
    setMessages((current) => current.map((message) => {
      if (message.id !== targetMessageId || !message.pendingTaskShortcuts?.length) return message;
      const updated = {
        ...message,
        pendingTaskShortcuts: message.pendingTaskShortcuts.map((task) => task.id === taskId ? {...task, status} : task),
      };
      persistMessagePayload(updated);
      return updated;
    }));
  };

  const completePendingTask = async (targetMessageId: string, task: AssistantPendingTaskShortcut) => {
    if (busy || completingTaskId || task.status === 'completed') return;
    setCompletingTaskId(task.id);
    updatePendingTaskShortcutStatus(targetMessageId, task.id, 'completed');
    try {
      await activities.update(uid, task.id, {status: 'completed'});
      void recordTaskCompleted(task.id);
    } catch (error) {
      updatePendingTaskShortcutStatus(targetMessageId, task.id, 'pending');
      showToast('อัปเดตงานไม่สำเร็จ', assistantErrorMessage(classifyAssistantError(error)));
    } finally {
      setCompletingTaskId('');
    }
  };

  const rateAssistant = (target: AssistantChatMessage, rating: AssistantFeedbackRating) => {
    setMessages((current) => current.map((message) => {
      if (message.id !== target.id) return message;
      const updated = {...message, feedback: rating};
      persistMessagePayload(updated);
      return updated;
    }));
    recordAssistantTelemetry({
      errorKind: target.errorKind,
      helpful: rating,
      intent: target.intent ?? 'unknown',
      interactionId: target.id,
      latencyMs: target.latencyMs ?? 0,
      source: target.source ?? 'fallback',
    }).catch(() => undefined);
  };

  const startNewConversation = async (mode: 'persistent' | 'temporary') => {
    if (busy || !historyReady) return;
    const nextConversationId = createAssistantConversationId();
    const nextState = createAssistantConversationState(nextConversationId);
    temporaryChatRef.current = mode === 'temporary';
    setTemporaryChat(mode === 'temporary');
    setConversationId(nextConversationId);
    setConversationState(nextState);
    setInput('');
    autoScrollPendingRef.current = true;
    setMessages([assistantIntroMessage()]);
    setInlineAdaptiveSuggestions([]);
    setNewChatMenuOpen(false);
    setQuickAddCategory(null);
    setQuickAddOpen(false);
    if (mode === 'persistent') await AsyncStorage.setItem(assistantActiveConversationKey(uid), nextConversationId);
  };

  const openChatHistory = async () => {
    if (!historyReady) return;
    setChatHistoryOpen(true);
    setChatHistoryLoading(true);
    try {
      setChatHistory(await listAssistantConversations(uid));
    } catch {
      showToast('เปิดประวัติไม่สำเร็จ', 'กรุณาตรวจการเชื่อมต่อแล้วลองอีกครั้ง');
    } finally {
      setChatHistoryLoading(false);
    }
  };

  const selectHistoryConversation = async (conversation: AssistantConversationSummary) => {
    if (busy) return;
    setChatHistoryLoading(true);
    try {
      const restored = await loadAssistantConversation(uid, conversation);
      temporaryChatRef.current = false;
      setTemporaryChat(false);
      setConversationId(conversation.id);
      setConversationState(restored.state);
      autoScrollPendingRef.current = true;
      const restoredMessages = sanitizeAssistantMessages(restored.messages);
      setMessages(restoredMessages.length ? restoredMessages : [assistantIntroMessage()]);
      setInlineAdaptiveSuggestions([]);
      setChatHistoryOpen(false);
      await AsyncStorage.setItem(assistantActiveConversationKey(uid), conversation.id);
    } catch {
      showToast('เปิดแชทไม่สำเร็จ', 'ไม่สามารถโหลดข้อความของแชทนี้ได้');
    } finally {
      setChatHistoryLoading(false);
    }
  };

  // Asked through `ConfirmDialog`, not `Alert.alert`: the latter is an empty
  // function on react-native-web, so on web no prompt appeared and the delete
  // it guarded was never reached.
  const confirmDeleteHistoryConversation = () => {
    const conversation = deletingConversation;
    setDeletingConversation(null);
    if (!conversation) return;
    deleteAssistantConversation(uid, conversation.id)
      .then(() => setChatHistory((current) => current.filter((item) => item.id !== conversation.id)))
      .catch(() => showToast('ลบไม่สำเร็จ', 'กรุณาลองใหม่อีกครั้ง'));
  };

  const sendMessage = async (message?: string) => {
    const text = (message ?? input).trim();
    if (!text || busy || !historyReady) return;
    const conversation = messages.slice(-12);
    const nextIntent = classifyAssistantIntent(text, conversationState.lastIntent);
    const nextConversationState = updateAssistantConversationState(conversationState, text, nextIntent);
    setQuickAddOpen(false);
    setQuickAddCategory(null);
    setInput('');
    const ticket = beginReply();
    // Shadowed so every reply below this line belongs to this request and goes quiet if the user stops it.
    const appendAssistant = replyFor(ticket);
    setConversationState(nextConversationState);
    appendUser(text, nextConversationState);
    try {
      // Searched over the whole chat, not the twelve turns sent as context: a
      // draft the user left open, asked three other things about, then came
      // back to fell outside that window and the edit became a brand new task.
      // Only one schedule draft is ever pending at a time, so the last one
      // found is the one on screen.
      const latestDraft = [...messages].reverse().find((turn) => turn.proposedAction?.entity === 'schedule' && turn.proposedAction.status === 'pending');
      const revision = latestDraft?.proposedAction ? editScheduleDraft(text, latestDraft.proposedAction) : null;
      if (revision) {
        if (revision.action && latestDraft) {
          updateActionStatus(latestDraft.id, 'rejected');
          appendAssistant('ปรับเฉพาะเวลาของร่างเดิมแล้ว ชื่องานเดิมยังอยู่ ตรวจการ์ดด้านล่างก่อนยืนยันบันทึก', revision.action);
        } else appendAssistant(revision.error ?? 'กรุณาแก้วันที่/เวลาบนการ์ดเดิม');
        return;
      }
      // Use semantic scheduling analysis for all schedule/task language. The
      // user does not need command words; read-only questions simply fall
      // through when Adaptive returns no operation.
      const explicitAdaptiveCommand = isAdaptiveSchedulingCommand(text);
      const readOnlyRequest = isReadOnlyOrAdviceRequest(text) && !explicitMutationClause(text);
      if (!readOnlyRequest && (explicitAdaptiveCommand || nextIntent === 'schedule' || nextIntent === 'task_note')) {
        let adaptive: Awaited<ReturnType<typeof adaptiveScheduling.processCommand>> | undefined;
        try {
          adaptive = await adaptiveScheduling.processCommand(text);
        } catch (error) {
          // A semantic preflight must never block ordinary schedule/task
          // questions. Explicit Adaptive commands still surface the error.
          if (explicitAdaptiveCommand) throw error;
        }
        if (adaptive?.preferencePatch) {
          const confirmed = await confirmAdaptivePreference();
          if (confirmed) {
            await adaptiveScheduling.updatePreferences(adaptive.preferencePatch);
            appendAssistant('บันทึกข้อกำหนดเวลาไว้แล้วนะ ระบบจะให้ค่าที่คุณเลือกมีสิทธิ์เหนือรูปแบบที่เรียนรู้ และยังตรวจเวลาว่างจริงทุกครั้ง');
          } else appendAssistant('ยังไม่บันทึกการตั้งค่านี้นะ ตารางเดิมไม่ถูกเปลี่ยน');
          return;
        }
        if (adaptive?.proposedActivity) {
          const proposal = adaptive.proposedActivity;
          const proposalTimeZone = validTimeZone(proposal.generatedForTimeZone);
          const endTime = new Intl.DateTimeFormat('th-TH', {timeStyle: 'short', timeZone: proposalTimeZone}).format(new Date(proposal.endAt));
          appendAssistant(
            `${proposal.explanation}\n\nฉันเตรียมช่วง ${formatDate(proposal.startAt, proposalTimeZone)} ถึง ${endTime} ให้แล้ว ตรวจการ์ดและกดยืนยันเพื่อเพิ่มลงตารางจริงได้เลย`,
            adaptiveProposalAction(proposal),
            {suggestions: [`จัด ${proposal.title} ช่วงเย็น`, `จัด ${proposal.title} 90 นาที`]},
            undefined,
            nextConversationState,
          );
          return;
        }
        if (adaptive?.suggestion) {
          setInlineAdaptiveSuggestions((current) => [adaptive.suggestion as AdaptiveSuggestion, ...current.filter((item) => item.id !== adaptive.suggestion?.id)].slice(0, 4));
          appendAssistant(`${adaptive.suggestion.explanation}\n\nฉันแสดงตัวเลือก Adaptive ไว้ด้านล่างแล้ว คุณยืนยัน ปฏิเสธ หรือเลือกเวลาอื่นได้ในแชตนี้เลย`);
          return;
        }
        if (adaptive?.suggestions) {
          setInlineAdaptiveSuggestions(adaptive.suggestions.filter((item) => item.status === 'pending').slice(0, 4));
          appendAssistant(adaptive.suggestions.length
            ? `พบงานยืดหยุ่นที่ย้ายได้ ${adaptive.suggestions.length} รายการ ฉันแสดงตัวเลือกไว้ในแชตนี้แล้ว และจะยังไม่ย้ายงานจนกว่าคุณจะยืนยัน`
            : 'ตรวจแล้ว แต่ยังไม่พบงานยืดหยุ่นที่ย้ายได้โดยไม่ชนตาราง กำหนดส่ง เวลานอน หรือภาระงานที่ตั้งไว้');
          return;
        }
        if (adaptive?.dashboard) {
          setAdaptiveInsightDashboard(adaptive.dashboard);
          setInlineAdaptiveSuggestions(adaptive.dashboard.suggestions.filter((item) => item.status === 'pending').slice(0, 4));
          const insight = adaptive.dashboard.insights[0]?.message;
          appendAssistant(insight ?? `สัปดาห์นี้มีภาระงานรวม ${adaptive.dashboard.weeklyWorkloadMinutes.toLocaleString('th-TH')} นาที แต่ยังมีข้อมูลพฤติกรรมไม่พอสำหรับสรุปช่วงที่ทำงานได้ดีที่สุด`);
          return;
        }
        if (adaptive?.history) {
          appendAssistant(adaptive.history.reason || 'การย้ายครั้งล่าสุดผ่านการตรวจ conflict, deadline, เวลานอน และ workload ก่อนบันทึก');
          return;
        }
        if (adaptive?.message) {
          appendAssistant(adaptive.message);
          return;
        }
      }
      const reply = await buildAssistantReply(uid, text, conversation, {
        conversationId,
        conversationState: nextConversationState,
      });
      const interactionId = messageId('assistant');
      const responseState = mergeAssistantConversationState(nextConversationState, reply.statePatch);
      appendAssistant(reply.content, reply.proposedAction, reply, interactionId, responseState);
      setConversationState(responseState);
      recordAssistantTelemetry({
        errorKind: reply.errorKind,
        intent: reply.intent,
        interactionId,
        latencyMs: reply.latencyMs,
        source: reply.source,
      }).catch(() => undefined);
    } catch (error) {
      appendAssistant(isAppCheckError(error)
        ? appCheckErrorMessage(error)
        : 'ตอนนี้ผู้ช่วยยังเชื่อมต่อข้อมูลไม่สำเร็จ แต่ข้อมูลเดิมไม่ได้หาย กรุณาลองใหม่อีกครั้ง');
    } finally {
      if (ticket === replyTicket.current) setBusy(false);
    }
  };

  const activateAdaptiveAi = async (retry = false) => {
    if (adaptiveActivationInFlightRef.current || (busy && !retry) || !historyReady || adaptiveActivationStatus === 'loading') return;
    adaptiveActivationInFlightRef.current = true;
    const prompt = 'เปิด Adaptive AI และช่วยจัดงานค้างลงในเวลาว่างตั้งแต่ตอนนี้';
    const nextIntent = classifyAssistantIntent(prompt, conversationState.lastIntent);
    const nextConversationState = updateAssistantConversationState(conversationState, prompt, nextIntent);
    setQuickAddOpen(false);
    setQuickAddCategory(null);
    setAdaptiveActivationError('');
    setAdaptiveActivationStatus('loading');
    const ticket = beginReply();
    // Shadowed so every reply below this line belongs to this request and goes quiet if the user stops it.
    const appendAssistant = replyFor(ticket);
    if (!retry) {
      setConversationState(nextConversationState);
      appendUser(prompt, nextConversationState);
    }
    try {
      const result = await adaptiveScheduling.activate();
      if (!result.enabled) throw new Error('Adaptive AI was not enabled.');
      const suggestions = result.suggestions.slice(0, 3);
      setInlineAdaptiveSuggestions(suggestions.filter((item) => item.status === 'pending'));
      if (!suggestions.length) {
        const checked = result.diagnostics.eligibleActivities;
        appendAssistant(
          checked
            ? `เปิด Adaptive AI แล้ว และตรวจงานยืดหยุ่น ${checked} งาน แต่ยังไม่พบช่วงใหม่ที่ผ่านเงื่อนไขทั้งหมด ตารางเดิมจึงไม่ถูกเปลี่ยน`
            : 'เปิด Adaptive AI แล้ว แต่ยังไม่มีงานยืดหยุ่นที่พร้อมจัดใหม่ คุณพิมพ์กิจกรรมตามธรรมชาติได้เลย เช่น “อ่านหนังสือทบทวนบทเรียน” แล้วฉันจะหาช่วงว่างให้ยืนยัน',
          undefined,
          {suggestions: ['อ่านหนังสือทบทวนบทเรียน', 'ช่วยจัดทั้งสัปดาห์', 'งานไหนควรทำก่อน']},
          undefined,
          nextConversationState,
        );
      } else {
        const scheduleLines = suggestions.map((suggestion, index) =>
          `${index + 1}. ${suggestion.taskTitle} — ${formatDate(suggestion.suggestedStartAt, suggestion.generatedForTimeZone)}`,
        );
        appendAssistant(
          `เปิด Adaptive AI แล้ว พบ ${suggestions.length} งานที่จัดลงช่วงว่างได้โดยไม่ชนตาราง กำหนดส่ง หรือเวลาพัก\n\n${scheduleLines.join('\n')}\n\nยืนยัน ปฏิเสธ หรือเลือกเวลาอื่นได้จากการ์ด Adaptive ในแชตนี้ ตารางจะยังไม่เปลี่ยนจนกว่าคุณจะยืนยัน`,
          undefined,
          {suggestions: ['ช่วยจัดทั้งสัปดาห์', 'ทำไมเลือกเวลานี้']},
          undefined,
          nextConversationState,
        );
      }
      setAdaptiveActivationStatus('success');
    } catch (error) {
      setAdaptiveActivationError(
        isAppCheckError(error)
          ? appCheckErrorMessage(error)
          : 'ยังเปิด Adaptive AI ไม่สำเร็จ ตารางเดิมไม่ได้ถูกเปลี่ยน คุณสามารถลองใหม่ได้ทันที',
      );
      setAdaptiveActivationStatus('error');
    } finally {
      adaptiveActivationInFlightRef.current = false;
      if (ticket === replyTicket.current) setBusy(false);
    }
  };

  const runInlineAdaptiveAction = async (
    key: string,
    action: () => Promise<unknown>,
    title: string,
    successMessage: string,
  ) => {
    if (inlineAdaptiveActionInFlightRef.current || busy) return;
    inlineAdaptiveActionInFlightRef.current = true;
    retryInlineAdaptiveActionRef.current = {action, key, successMessage, title};
    setInlineAdaptiveBusyKey(key);
    setInlineAdaptiveError('');
    setInlineAdaptiveFeedbackMessage('กำลังตรวจตารางและข้อมูลล่าสุดก่อนบันทึก');
    setInlineAdaptiveFeedbackStatus('loading');
    setInlineAdaptiveFeedbackTitle(title);
    const ticket = beginReply();
    // Shadowed so every reply below this line belongs to this request and goes quiet if the user stops it.
    const appendAssistant = replyFor(ticket);
    try {
      await action();
      const dashboard = await adaptiveScheduling.getDashboard();
      setAdaptiveInsightDashboard(dashboard);
      setInlineAdaptiveSuggestions(dashboard.suggestions.filter((item) => item.status === 'pending').slice(0, 4));
      appendAssistant(successMessage);
      setInlineAdaptiveFeedbackMessage(successMessage);
      setInlineAdaptiveFeedbackStatus('success');
    } catch (error) {
      setInlineAdaptiveError(isAppCheckError(error) ? appCheckErrorMessage(error) : 'ดำเนินการกับคำแนะนำนี้ไม่สำเร็จ ตารางเดิมยังไม่ถูกเปลี่ยน กรุณาลองใหม่ได้ทันที');
      setInlineAdaptiveFeedbackStatus('error');
    } finally {
      inlineAdaptiveActionInFlightRef.current = false;
      setInlineAdaptiveBusyKey('');
      if (ticket === replyTicket.current) setBusy(false);
    }
  };

  const confirmAction = async (targetMessageId: string, action: AssistantProposedAction) => {
    if (confirmActionInFlightRef.current || busy || action.status !== 'pending') return;
    confirmActionInFlightRef.current = true;
    retryConfirmActionRef.current = {action, targetMessageId};
    setConfirmationActionError('');
    setConfirmationActionStatus('loading');
    const ticket = beginReply();
    // Shadowed so every reply below this line belongs to this request and goes quiet if the user stops it.
    const appendAssistant = replyFor(ticket);
    setSavingActionId(action.id);
    try {
      const result = await confirmAssistantAction(uid, action);
      if (action.entity === 'schedule' && 'requiresConflictConfirmation' in result && result.requiresConflictConfirmation) {
        setPendingScheduleConflict({action, conflicts: result.conflicts, targetMessageId});
        setConfirmationActionStatus('idle');
        return;
      }
      const stayInAssistant = action.entity === 'memory' || (action.entity === 'schedule' && action.payload.aiScheduled === true);
      updateActionStatus(targetMessageId, 'confirmed', action);
      appendAssistant(action.entity === 'memory'
        ? 'จำการตั้งค่านี้ไว้ในเครื่องแล้วนะ ฉันจะนำไปใช้ตอนช่วยวางแผนครั้งถัดไป'
        : stayInAssistant
          ? 'บันทึกกิจกรรม Adaptive ลงตารางแล้ว และยังอยู่ในหน้าแชตนี้เพื่อให้คุณจัดรายการต่อได้เลย'
          : 'บันทึกลง Firebase แล้วนะ เปิดหน้าที่เกี่ยวข้องต่อได้เลย');
      setPendingNavigationPage(stayInAssistant ? '' : result.page);
      setConfirmationActionStatus('success');
    } catch (error) {
      setConfirmationActionError(isAppCheckError(error) ? appCheckErrorMessage(error) : assistantActionErrorMessage(error));
      setConfirmationActionStatus('error');
    } finally {
      confirmActionInFlightRef.current = false;
      setSavingActionId('');
      if (ticket === replyTicket.current) setBusy(false);
    }
  };

  const rejectAction = (targetMessageId: string, action: AssistantProposedAction) => {
    if (busy || action.status !== 'pending') return;
    updateActionStatus(targetMessageId, 'rejected');
    appendAssistant('โอเค ไม่บันทึกรายการนี้นะ');
  };

  const chooseQuickAdd = (prompt: string) => {
    setInput(prompt);
    setQuickAddOpen(false);
    setQuickAddCategory(null);
  };

  const openOcrShortcutEditor = () => {
    setOcrShortcutDrafts(ocrShortcuts.map((shortcut) => ({...shortcut})));
    setOcrShortcutEditorOpen(true);
  };

  const saveOcrShortcutEditor = async () => {
    const validShortcuts = ocrShortcutDrafts.slice(0, 4).flatMap((item): QuickAddSuggestion[] => {
      const title = item.title.trim().slice(0, 40);
      const prompt = item.prompt.trim().slice(0, 240);
      if (!title || !prompt) return [];
      return [{detail: prompt.slice(0, 90), icon: 'document_scanner', prompt, title}];
    });
    if (!validShortcuts.length) {
      showToast('ยังบันทึกไม่ได้', 'กรุณาใส่ชื่อและคำถามอย่างน้อย 1 รายการ');
      return;
    }
    setOcrShortcuts(validShortcuts);
    setOcrShortcutEditorOpen(false);
    await AsyncStorage.setItem(ocrShortcutsKey(uid), JSON.stringify(validShortcuts));
  };

  const stopVoiceInput = async () => {
    if (Platform.OS === 'web') {
      if (browserMediaRecorderRef.current?.state === 'recording') {
        browserMediaRecorderRef.current.stop();
        return;
      }
      browserSpeechRecognitionRef.current?.stop();
      browserSpeechRecognitionRef.current = null;
      setListening(false);
      return;
    }
    try {
      const Voice = await loadVoiceInputModule();
      if (!Voice) return;
      await Voice.stop();
    } catch {
      // Stopping can fail if the recognizer already ended. The UI should still reset.
    } finally {
      setListening(false);
    }
  };

  // The browser recogniser writes straight into the input box with no server
  // round trip, so it is preferred on web. Returns false when this browser has
  // no SpeechRecognition support and the MediaRecorder fallback should run.
  const startBrowserSpeechInput = () => {
    if (browserSpeechUnusableRef.current) return false;
    const recognition = createBrowserSpeechRecognition();
    if (!recognition) return false;
    speechBaseInputRef.current = input.trimEnd();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'th-TH';
    recognition.onresult = (event) => {
      const spokenParts: string[] = [];
      for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
        const spoken = event.results[index]?.[0]?.transcript?.trim();
        if (spoken) spokenParts.push(spoken);
      }
      if (!spokenParts.length) return;
      setInput([speechBaseInputRef.current, spokenParts.join(' ')].filter(Boolean).join(' '));
    };
    recognition.onerror = (event) => {
      browserSpeechRecognitionRef.current = null;
      setListening(false);
      if (event.error === 'aborted') return;
      if (event.error === 'not-allowed') {
        appendAssistant('ยังไม่ได้รับสิทธิ์ไมโครโฟนครับ อนุญาตไมโครโฟนให้เว็บไซต์ SmartLife แล้วกดไมค์ใหม่ได้เลย');
        return;
      }
      browserSpeechUnusableRef.current = true;
      appendAssistant('ฟังเสียงไม่สำเร็จครับ กดไมค์อีกครั้งได้เลย ระบบจะสลับไปใช้การอัดเสียงแล้วถอดความให้อัตโนมัติ');
    };
    recognition.onend = () => {
      browserSpeechRecognitionRef.current = null;
      setListening(false);
    };
    browserSpeechRecognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      browserSpeechRecognitionRef.current = null;
      setListening(false);
      return false;
    }
    return true;
  };

  const startVoiceInput = async () => {
    if (busy) return;
    setQuickAddOpen(false);
    setQuickAddCategory(null);
    if (Platform.OS === 'web') {
      if (startBrowserSpeechInput()) return;
      if (typeof MediaRecorder !== 'undefined' && globalThis.navigator?.mediaDevices?.getUserMedia) {
        try {
          const stream = await globalThis.navigator.mediaDevices.getUserMedia({audio: true});
          const preferredMimeType = preferredBrowserAudioMimeType();
          const recorder = preferredMimeType
            ? new MediaRecorder(stream, {audioBitsPerSecond: 64_000, mimeType: preferredMimeType})
            : new MediaRecorder(stream, {audioBitsPerSecond: 64_000});
          browserMediaStreamRef.current = stream;
          browserMediaRecorderRef.current = recorder;
          browserVoiceChunksRef.current = [];
          speechBaseInputRef.current = input.trimEnd();
          recorder.ondataavailable = (event) => {
            if (event.data?.size) browserVoiceChunksRef.current.push(event.data);
          };
          recorder.onerror = () => {
            if (browserVoiceTimeoutRef.current) clearTimeout(browserVoiceTimeoutRef.current);
            browserVoiceTimeoutRef.current = null;
            browserMediaRecorderRef.current = null;
            browserMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
            browserMediaStreamRef.current = null;
            setListening(false);
            appendAssistant('บันทึกเสียงจากไมโครโฟนไม่สำเร็จครับ กรุณาตรวจสิทธิ์ไมโครโฟนแล้วลองใหม่');
          };
          recorder.onstop = () => {
            const chunks = browserVoiceChunksRef.current;
            browserVoiceChunksRef.current = [];
            if (browserVoiceTimeoutRef.current) clearTimeout(browserVoiceTimeoutRef.current);
            browserVoiceTimeoutRef.current = null;
            browserMediaRecorderRef.current = null;
            browserMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
            browserMediaStreamRef.current = null;
            setListening(false);
            const blob = new Blob(chunks, {type: recorder.mimeType || preferredMimeType || 'audio/webm'});
            if (!blob.size) {
              appendAssistant('ยังไม่ได้ยินเสียงครับ กดไมค์แล้วพูดใหม่อีกครั้งได้เลย');
              return;
            }
            // Named rather than shadowed here: this block already speaks above,
            // before the ticket exists.
            const voiceTicket = beginReply();
            const replyToVoice = replyFor(voiceTicket);
            transcribeAssistantAudio(blob)
              .then((transcript) => {
                // Stopped means stopped: dropping the words into the composer
                // minutes later is the same surprise as a late reply.
                if (voiceTicket !== replyTicket.current) return;
                setInput([speechBaseInputRef.current, transcript].filter(Boolean).join(' '));
                requestAnimationFrame(() => chatScrollRef.current?.scrollToEnd({animated: true}));
              })
              .catch((error) => {
                const kind = classifyAssistantError(error);
                replyToVoice(kind === 'unknown'
                  ? 'แปลงเสียงเป็นข้อความไม่สำเร็จครับ กรุณาลองพูดใหม่อีกครั้ง'
                  : assistantErrorMessage(kind));
              })
              .finally(() => { if (voiceTicket === replyTicket.current) setBusy(false); });
          };
          recorder.start(250);
          setListening(true);
          browserVoiceTimeoutRef.current = setTimeout(() => {
            if (browserMediaRecorderRef.current?.state === 'recording') browserMediaRecorderRef.current.stop();
          }, 30_000);
          return;
        } catch (error) {
          browserMediaStreamRef.current?.getTracks().forEach((track) => track.stop());
          browserMediaStreamRef.current = null;
          const message = error instanceof Error ? error.message : String(error);
          appendAssistant(/notallowed|not allowed|permission|denied/i.test(message)
            ? 'ยังไม่ได้รับสิทธิ์ไมโครโฟนครับ อนุญาตไมโครโฟนให้เว็บไซต์ SmartLife แล้วกดไมค์ใหม่ได้เลย'
            : 'เปิดไมโครโฟนบนเว็บไม่สำเร็จครับ กรุณาตรวจว่าไม่มีโปรแกรมอื่นใช้ไมค์อยู่แล้วลองใหม่');
          return;
        }
      }
      appendAssistant('เบราว์เซอร์นี้ยังไม่รองรับการพิมพ์ด้วยเสียง กรุณาเปิด SmartLife ด้วย Chrome หรือ Edge รุ่นล่าสุด หรือพิมพ์ข้อความในช่องแชทได้เลย');
      return;
    }
    try {
      const Voice = await loadVoiceInputModule();
      if (!Voice) {
        appendAssistant('แอปที่เปิดอยู่ยังไม่พบระบบรับเสียง ให้ติดตั้ง app-debug.apk ล่าสุดแล้วเปิดผ่าน start-smartlife-mumu.cmd ได้เลย ไม่ต้อง rebuild ซ้ำ');
        return;
      }
      const granted = await requestMicrophonePermission();
      if (!granted) {
        appendAssistant('ยังไม่ได้รับสิทธิ์ไมโครโฟน เลยฟังเสียงไม่ได้ตอนนี้นะ เปิด permission ไมโครโฟนให้ SmartLife แล้วลองกดไมค์อีกครั้ง');
        return;
      }
      if (Platform.OS === 'android') {
        const services = await Promise.resolve(Voice.getSpeechRecognitionServices());
        if (Array.isArray(services) && services.length === 0) {
          appendAssistant('APK นี้มีโมดูลไมค์แล้ว แต่ MuMu เครื่องนี้ยังไม่มีบริการรู้จำเสียงของ Android จึงยังแปลงเสียงเป็นข้อความไม่ได้\n\nให้ติดตั้ง Google app หรือ Speech Recognition & Synthesis ใน MuMu หรือทดสอบ APK ล่าสุดบนมือถือ Android จริงได้เลย ไม่ต้อง rebuild ซ้ำ');
          return;
        }
      }
      speechBaseInputRef.current = input.trimEnd();
      Voice.onSpeechPartialResults = (event) => {
        const spoken = event.value?.[0]?.trim();
        if (!spoken) return;
        setInput([speechBaseInputRef.current, spoken].filter(Boolean).join(' '));
      };
      Voice.onSpeechResults = (event) => {
        const spoken = event.value?.[0]?.trim();
        if (!spoken) return;
        setInput([speechBaseInputRef.current, spoken].filter(Boolean).join(' '));
      };
      Voice.onSpeechError = () => {
        setListening(false);
        appendAssistant('ฟังเสียงไม่สำเร็จนะ ลองกดไมค์แล้วพูดใหม่อีกครั้ง หรือพิมพ์ต่อเองได้เลย');
      };
      Voice.onSpeechEnd = () => setListening(false);
      setListening(true);
      await Voice.start('th-TH');
    } catch (error) {
      setListening(false);
      const message = error instanceof Error ? error.message : '';
      if (/recognition service|speech recognizer|not available/i.test(message)) {
        appendAssistant('ระบบไมค์ในแอปพร้อมแล้ว แต่ MuMu ยังไม่มีบริการรู้จำเสียง ให้ติดตั้ง Google app หรือ Speech Recognition & Synthesis ใน MuMu แล้วลองใหม่ ไม่ต้อง rebuild');
        return;
      }
      appendAssistant('เริ่มฟังเสียงไม่ได้ตอนนี้นะ ลองใหม่อีกครั้ง หรือพิมพ์ข้อความเองก่อนก็ได้');
    }
  };

  const toggleVoiceInput = () => {
    if (listening) {
      stopVoiceInput().catch(() => setListening(false));
      return;
    }
    startVoiceInput().catch(() => setListening(false));
  };

  // The dashboard's mic icon and its "วันนี้ฉันมีเรียนกี่โมง?" prompt row used
  // to just open a blank chat -- the user still had to tap the mic or retype
  // the question here. `historyReady` gates this because `sendMessage` itself
  // silently no-ops before it (chat state has to load first), so it has to be
  // the effect's own dependency, not a one-time mount check.
  // The ref alone only guards one mount. On web the parameter stays in the
  // address bar after it is consumed, so leaving the tab and coming back
  // remounts this screen with `autoAsk` still set and asks the question a
  // second time -- which is what produced two identical bubbles nobody typed.
  // Clearing the parameter is what actually makes it single-use: the ref keeps
  // this mount honest, and the empty URL keeps every later one honest.
  const autoActionRanRef = useRef(false);
  useEffect(() => {
    if (autoActionRanRef.current || !historyReady || (!autoAsk && !autoListen)) return;
    autoActionRanRef.current = true;
    if (autoAsk) void sendMessage(autoAsk);
    else toggleVoiceInput();
    // `setParams` rewrites the current route's query in place, so this drops
    // the parameter without a navigation the user would see or could go back
    // through. The re-render it causes re-enters the effect, which the ref
    // above stops at the first line.
    router.setParams({autoAsk: undefined, autoListen: undefined});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk, autoListen, historyReady]);

  const pickImportFile = async () => {
    if (busy) return;
    setQuickAddOpen(false);
    setQuickAddCategory(null);
    const ticket = beginReply();
    // Shadowed so every reply below this line belongs to this request and goes quiet if the user stops it.
    const appendAssistant = replyFor(ticket);
    try {
      const DocumentPicker = await import('expo-document-picker');
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ['application/pdf', 'text/plain', 'text/csv', 'text/calendar', 'text/*'],
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (asset.size && asset.size > 8 * 1024 * 1024) {
        appendAssistant('ไฟล์นี้มีขนาดเกิน 8 MB กรุณาเลือกไฟล์ที่เล็กลง');
        return;
      }
      appendUser(`อัปโหลดไฟล์: ${asset.name}`);
      const analysis = await uploadAndAnalyzeAssistantFile({
        contentType: asset.mimeType,
        name: asset.name,
        uid,
        uri: asset.uri,
      });
      appendAssistant(analysis.content, undefined, {suggestions: analysis.suggestions});
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/ExpoDocumentPicker|native module|Cannot find native module/i.test(message)) {
        appendAssistant('เปิดตัวเลือกไฟล์ไม่สำเร็จ กรุณาปิดแล้วเปิด SmartLife ใหม่และลองอีกครั้ง หากยังเกิดซ้ำจึงค่อยติดตั้ง Development Build รุ่นล่าสุด');
        return;
      }
      if (/รองรับเฉพาะ|ชนิดไฟล์|8 MB|too large/i.test(message)) {
        appendAssistant(message);
        return;
      }
      if (/storage\/(?:unauthorized|unauthenticated)/i.test(message)) {
        appendAssistant('บัญชีนี้ยังอัปโหลดไฟล์เข้า SmartLife Storage ไม่สำเร็จครับ กรุณาออกจากระบบแล้วเข้าสู่ระบบใหม่หนึ่งครั้ง จากนั้นเลือกไฟล์เดิมอีกครั้ง');
        return;
      }
      const kind = classifyAssistantError(error);
      appendAssistant(kind === 'unknown'
        ? 'อัปโหลดหรือวิเคราะห์ไฟล์ไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองเลือกไฟล์ PDF, TXT, CSV หรือ ICS อีกครั้ง'
        : assistantErrorMessage(kind));
    } finally {
      if (ticket === replyTicket.current) setBusy(false);
    }
  };

  return (
    <UserShell active="smartlife_ai_assistant" edgeToEdge onNavigate={onNavigate} scroll={false}>
      <AsyncActionOverlay
        cancelLabel="ปิด"
        errorMessage={adaptiveActivationError}
        loadingMessage="กำลังเปิด Adaptive AI ตรวจงานค้าง และหาช่วงว่างจากเวลาปัจจุบัน"
        onCancel={() => setAdaptiveActivationStatus('idle')}
        onRequestClose={() => setAdaptiveActivationStatus('idle')}
        onRetry={() => activateAdaptiveAi(true)}
        onSuccessAnimationComplete={() => setAdaptiveActivationStatus('idle')}
        slowMessage="กำลังตรวจตาราง กำหนดส่ง เวลานอน และภาระงานเพิ่มเติม…"
        status={adaptiveActivationStatus}
        successMessage="เปิดใช้งานแล้ว คำแนะนำที่พบถูกเตรียมไว้ให้ตรวจและยืนยัน"
        title={adaptiveActivationStatus === 'success' ? 'Adaptive AI พร้อมใช้งาน' : adaptiveActivationStatus === 'error' ? 'เปิดใช้งานไม่สำเร็จ' : 'กำลังเตรียม Adaptive AI'}
      />
      <AsyncActionOverlay
        cancelLabel="ปิด"
        errorMessage={inlineAdaptiveError}
        loadingMessage={inlineAdaptiveFeedbackMessage}
        onCancel={() => setInlineAdaptiveFeedbackStatus('idle')}
        onRequestClose={() => setInlineAdaptiveFeedbackStatus('idle')}
        onRetry={() => {
          const retry = retryInlineAdaptiveActionRef.current;
          return retry ? runInlineAdaptiveAction(retry.key, retry.action, retry.title, retry.successMessage) : undefined;
        }}
        onSuccessAnimationComplete={() => setInlineAdaptiveFeedbackStatus('idle')}
        slowMessage="กำลังตรวจ conflict กำหนดส่ง เวลาพัก และข้อมูลล่าสุดจาก Firebase…"
        status={inlineAdaptiveFeedbackStatus}
        successMessage={inlineAdaptiveFeedbackMessage}
        title={inlineAdaptiveFeedbackTitle || 'Adaptive AI'}
      />
      <AsyncActionOverlay
        cancelLabel="ปิด"
        errorMessage={confirmationActionError}
        loadingMessage="กำลังตรวจข้อมูลล่าสุดและบันทึกผ่าน SmartLife backend"
        onCancel={() => setConfirmationActionStatus('idle')}
        onRequestClose={() => setConfirmationActionStatus('idle')}
        onRetry={() => {
          const retry = retryConfirmActionRef.current;
          return retry ? confirmAction(retry.targetMessageId, retry.action) : undefined;
        }}
        onSuccessAnimationComplete={() => {
          setConfirmationActionStatus('idle');
          const page = pendingNavigationPage;
          setPendingNavigationPage('');
          if (page) onNavigate(page);
        }}
        slowMessage="กำลังยืนยันสิทธิ์ ตรวจความซ้ำ และรอ Firebase ตอบกลับ…"
        status={confirmationActionStatus}
        successMessage="ตรวจสอบและบันทึกเรียบร้อยแล้ว"
        title={confirmationActionStatus === 'success' ? 'บันทึกสำเร็จ' : confirmationActionStatus === 'error' ? 'บันทึกไม่สำเร็จ' : 'กำลังยืนยันรายการ'}
      />
      <ScheduleConflictDialog
        conflicts={pendingScheduleConflict?.conflicts ?? []}
        onConfirm={() => {
          const pending = pendingScheduleConflict;
          if (!pending) return;
          setPendingScheduleConflict(null);
          void confirmAction(pending.targetMessageId, {...pending.action, payload: {...pending.action.payload, allowOverlap: true}});
        }}
        onEdit={() => setPendingScheduleConflict(null)}
        proposedEndAt={pendingScheduleConflict?.action.payload.endAt ?? pendingScheduleConflict?.action.payload.startAt ?? new Date().toISOString()}
        proposedStartAt={pendingScheduleConflict?.action.payload.startAt ?? new Date().toISOString()}
        saving={Boolean(savingActionId)}
        timeZone={pendingScheduleConflict?.action.payload.generatedForTimeZone}
        visible={Boolean(pendingScheduleConflict)}
      />
      <ConfirmDialog
        confirmLabel="ลบ"
        message="ข้อความในแชทนี้จะถูกลบออกจากบัญชีของคุณ"
        onCancel={() => setDeletingConversation(null)}
        onConfirm={confirmDeleteHistoryConversation}
        title="ลบแชทนี้?"
        visible={Boolean(deletingConversation)}
      />
      <ConfirmDialog
        cancelLabel="ยังไม่บันทึก"
        confirmLabel="บันทึก"
        icon="tune"
        message="บันทึกช่วงเวลานี้เป็นข้อกำหนดสำหรับการจัดตารางครั้งต่อไปไหม?"
        onCancel={() => answerAdaptivePreference(false)}
        onConfirm={() => answerAdaptivePreference(true)}
        title="ยืนยันการตั้งค่า Adaptive"
        tone="neutral"
        visible={Boolean(adaptivePreferenceGate)}
      />
      {/* Refactored UI: keep the floating composer above the software keyboard. */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={local.keyboardAvoiding}>
      <View style={local.shell}>
        <ScrollView
          decelerationRate="normal"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          onContentSizeChange={() => {
            if (!autoScrollPendingRef.current) return;
            requestAnimationFrame(() => scrollToLatest(false));
          }}
          onScroll={(event) => {
            const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent;
            const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
            const shouldShow = hasConversation && distanceFromBottom > 180;
            if (scrollToBottomVisibleRef.current !== shouldShow) {
              scrollToBottomVisibleRef.current = shouldShow;
              setShowScrollToBottom(shouldShow);
            }
          }}
          ref={chatScrollRef}
          removeClippedSubviews={Platform.OS === 'android'}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={local.chatContent}
        >
          <View style={local.topBar}>
            <View style={local.topTitle}>
              <View style={local.titleRow}>
                <Text style={local.screenTitle}>AI Assistant</Text>
                {temporaryChat ? <View style={local.temporaryBadge}><MaterialIcon color="#5d8059" name="timer" size={12} /><Text style={local.temporaryBadgeText}>ชั่วคราว</Text></View> : null}
              </View>
            </View>
            <View style={local.topActions}>
              <Touchable accessibilityLabel="ย้อนดูประวัติแชท" onPress={openChatHistory} style={local.circleButton}>
                <MaterialIcon color="#26321f" name="history" size={20} />
              </Touchable>
              <Touchable accessibilityLabel="เริ่มแชทใหม่" disabled={busy || !historyReady} onLayout={newChatOnLayout} onPress={() => setNewChatMenuOpen(true)} ref={newChatRef} style={[(busy || !historyReady) ? local.newChatPillDisabled : local.newChatPill]}>
                <MaterialIcon color="#ffffff" name="add_comment" size={16} />
                <Text style={local.newChatPillText}>แชทใหม่</Text>
              </Touchable>
            </View>
          </View>

          {/* Refactored UI: clean greeting banner for the initial assistant state. */}
          <LinearGradient colors={['#5f8460', '#749279']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={[local.heroCard, {marginTop: 10}]}>
            <View style={local.heroCopy}>
              <Text style={local.heroTitle}>วันนี้ให้ช่วยอะไรดี?</Text>
              <Text style={local.heroText}>ตาราง · งาน · เงิน · บันทึก — ถามได้เลย</Text>
            </View>
            <MaterialIcon color="rgba(255,255,255,.72)" name="auto_awesome" size={44} />
          </LinearGradient>

          <Text style={local.shortcutSectionLabel}>ลองถาม AI ว่า...</Text>
          <View style={local.shortcutGrid}>
            {shortcuts.map(([icon, title, subtitle, target]) => (
              <Touchable disabled={busy} key={title} onPress={() => {
                if (target === ADAPTIVE_AI_SHORTCUT) {
                  setQuickAddOpen(true);
                  setQuickAddCategory('adaptive');
                  return;
                }
                void sendMessage(shortcutPrompts[target] ?? title);
              }} style={[local.shortcutCard, target === ADAPTIVE_AI_SHORTCUT && local.shortcutCardAdaptive, busy && local.disabled]}>
                <View style={local.shortcutIcon}><MaterialIcon color="#64835f" name={icon} size={20} /></View>
                <View style={{flex: 1}}>
                  <Text style={local.shortcutTitle}>{title}</Text>
                  <Text style={local.shortcutSubtitle}>{subtitle}</Text>
                </View>
                <MaterialIcon color="#b5c4b0" name="chevron_right" size={18} />
              </Touchable>
            ))}
          </View>

          {/* Added for AI Assistant: keep insights visible before and during a conversation. */}
          <AssistantInsights adaptiveDashboard={adaptiveInsightDashboard} data={weeklyInsights} onAsk={sendMessage} uid={uid} />

          {hasConversation ? <View style={local.chatStack}>
            {/* Refactored UI: conversations appear only after the first user interaction. */}
            {visibleMessages.map((message) => (
              <Reveal key={message.id}><MessageBubble busy={busy} completingTaskId={completingTaskId} key={message.id} message={message} onAsk={sendMessage} onCompleteTask={(messageIdValue, task) => void completePendingTask(messageIdValue, task)} onConfirm={confirmAction} onFeedback={rateAssistant} onReject={rejectAction} onSpeak={(target) => void speakAssistantMessage(target)} savingActionId={savingActionId} speaking={speakingMessageId === message.id} /></Reveal>
            ))}
            <InlineAdaptivePanel
              busyKey={inlineAdaptiveBusyKey}
              onAccept={(suggestion) => void runInlineAdaptiveAction(
                `accept-${suggestion.id}`,
                () => adaptiveScheduling.accept(suggestion.id),
                'กำลังยืนยันคำแนะนำ',
                `ยืนยันเวลาใหม่ให้ “${suggestion.taskTitle}” แล้ว ตารางอัปเดตเรียบร้อยและยังย้อนกลับได้จากประวัติ`,
              )}
              onAlternative={(suggestion, startAt) => void runInlineAdaptiveAction(
                `alternative-${suggestion.id}`,
                () => adaptiveScheduling.chooseAlternative(suggestion.id, new Date(startAt)),
                'กำลังตรวจเวลาอื่น',
                `เปลี่ยนเวลาที่เสนอสำหรับ “${suggestion.taskTitle}” แล้ว ตรวจการ์ดและกดยืนยันได้ในแชตนี้`,
              )}
              onReject={(suggestion) => void runInlineAdaptiveAction(
                `reject-${suggestion.id}`,
                () => adaptiveScheduling.reject(suggestion.id),
                'กำลังบันทึกการตัดสินใจ',
                `ไม่ใช้เวลาที่เสนอสำหรับ “${suggestion.taskTitle}” และบันทึกผลไว้ให้ Adaptive หลีกเลี่ยงคำแนะนำแบบเดิมแล้ว`,
              )}
              suggestions={inlineAdaptiveSuggestions}
            />
            {busy ? (
              <View style={local.thinking}>
                <ActivityIndicator color="#668d65" />
                <View style={{flex: 1}} accessibilityLiveRegion="polite">
                  <Text style={userStyles.bodyText}>{savingActionId ? 'กำลังตรวจสอบเวลาและบันทึก...' : 'กำลังวิเคราะห์คำถามและข้อมูลในระบบ...'}</Text>
                  <Text style={userStyles.muted}>รอแล้ว {busySeconds} วินาที • {busySeconds >= 30 ? 'ใช้เวลานานกว่าปกติ กรุณาอย่ากดส่งซ้ำ' : 'ระยะเวลาขึ้นกับข้อมูลและเครือข่าย'}</Text>
                </View>
                {/* Saving is deliberately not stoppable: the write may already
                    have gone through, and a button that says otherwise lies. */}
                {savingActionId ? null : (
                  <Touchable accessibilityLabel="หยุดรอคำตอบ" accessibilityRole="button" onPress={stopReply} style={local.stopButton}>
                    <MaterialIcon color="#7d6a63" name="stop_circle" size={17} />
                    <Text style={local.stopButtonText}>หยุด</Text>
                  </Touchable>
                )}
              </View>
            ) : null}
            <FocusSuggestions messages={visibleMessages} />
          </View> : null}
        </ScrollView>
        {showScrollToBottom && !quickAddOpen ? (
          <Touchable accessibilityLabel="เลื่อนไปข้อความล่าสุด" onPress={() => scrollToLatest(true)} style={({pressed}) => [local.scrollToBottomButton, pressed && local.pressed]}>
            <MaterialIcon color="#4e6f4d" name="keyboard_arrow_down" size={26} />
          </Touchable>
        ) : null}
        {/* Refactored UI: a soft fade keeps scrolling content legible behind the floating composer. */}
        <LinearGradient colors={['rgba(241,244,240,0)', '#f1f4f0']} end={{x: 0, y: 1}} pointerEvents="none" start={{x: 0, y: 0}} style={local.inputFade} />
        <View style={local.composerWrap}>
          {quickAddOpen ? <LinearGradient colors={['rgba(255,255,255,.99)', '#f5f8f1']} end={{x: 1, y: 1}} start={{x: 0, y: 0}} style={local.quickAddMenu}>
            <View style={local.quickAddHeader}>
              {selectedQuickAddCategory ? (
                <View style={local.quickAddCategoryHeader}>
                  <Touchable accessibilityLabel="กลับไปเลือกหมวด" onPress={() => setQuickAddCategory(null)} style={local.quickAddBack}>
                    <MaterialIcon color="#5d8059" name="arrow_back" size={18} />
                  </Touchable>
                  <View style={{flex: 1}}>
                    <Text style={local.quickAddTitle}>คำถามลัด: {selectedQuickAddCategory.title}</Text>
                    <Text style={local.quickAddHint}>แตะคำถามเพื่อถาม AI ได้ทันที</Text>
                  </View>
                  {selectedQuickAddCategory.id === 'ocr' ? <Touchable accessibilityLabel="ตั้งค่าคำถามลัด OCR" onPress={openOcrShortcutEditor} style={local.quickAddBack}><MaterialIcon color="#5d8059" name="settings" size={18} /></Touchable> : null}
                </View>
              ) : (
                <>
                  <Text style={local.quickAddTitle}>คำถามลัดและเพิ่มข้อมูล</Text>
                  <Text style={local.quickAddHint}>เลือกหมวดเพื่อดูคำถามที่ใช้บ่อย</Text>
                </>
              )}
            </View>
            <View style={local.quickAddGrid}>
              {selectedQuickAddCategory ? (
                <>
                  {selectedQuickAddCategory.suggestions.map((item) => (
                    <Touchable disabled={busy} key={item.title} onPress={() => item.action === 'activate_adaptive' ? void activateAdaptiveAi() : void sendMessage(item.prompt)} style={({pressed}) => [local.quickAddOption, pressed && local.pressed, busy && local.disabled]}>
                      <View style={local.quickAddIcon}><MaterialIcon color="#5d8059" name={item.icon} size={19} /></View>
                      <View style={local.quickAddCopy}>
                        <Text style={local.quickAddOptionTitle}>{item.title}</Text>
                        <Text numberOfLines={1} style={local.quickAddDetail}>{item.detail}</Text>
                      </View>
                      <MaterialIcon color="#9aa595" name="arrow_forward_ios" size={14} />
                    </Touchable>
                  ))}
                  {selectedQuickAddCategory.id !== 'adaptive' ? <Touchable disabled={busy} onPress={() => selectedQuickAddCategory.id === 'ocr' ? openOcrShortcutEditor() : chooseQuickAdd(selectedQuickAddCategory.createPrompt)} style={({pressed}) => [local.quickAddCreate, pressed && local.pressed, busy && local.disabled]}>
                    <MaterialIcon color="#ffffff" name={selectedQuickAddCategory.id === 'ocr' ? 'settings' : 'add'} size={19} />
                    <Text style={local.quickAddCreateText}>{selectedQuickAddCategory.createLabel}</Text>
                  </Touchable> : null}
                </>
              ) : (
                <>
                  {quickAddCategories.map((item) => (
                    <Touchable disabled={busy} key={item.id} onPress={() => setQuickAddCategory(item.id)} style={({pressed}) => [local.quickAddOption, pressed && local.pressed, busy && local.disabled]}>
                      <View style={local.quickAddIcon}><MaterialIcon color="#5d8059" name={item.icon} size={19} /></View>
                      <View style={local.quickAddCopy}>
                        <Text style={local.quickAddOptionTitle}>{item.title}</Text>
                        <Text numberOfLines={1} style={local.quickAddDetail}>{item.detail}</Text>
                      </View>
                      <MaterialIcon color="#9aa595" name="chevron_right" size={18} />
                    </Touchable>
                  ))}
                  <Touchable disabled={busy} onPress={pickImportFile} style={({pressed}) => [local.quickAddOption, pressed && local.pressed, busy && local.disabled]}>
                    <View style={local.quickAddIcon}><MaterialIcon color="#5d8059" name="upload_file" size={19} /></View>
                    <View style={local.quickAddCopy}>
                      <Text style={local.quickAddOptionTitle}>อัปโหลดไฟล์</Text>
                      <Text numberOfLines={1} style={local.quickAddDetail}>PDF, TXT, CSV ตารางเรียนหรืองาน</Text>
                    </View>
                  </Touchable>
                </>
              )}
            </View>
          </LinearGradient> : null}
          <View onLayout={composerOnLayout} ref={composerRef} style={local.composer}>
            <Touchable accessibilityLabel="เปิดคำถามลัดและเมนูเพิ่มข้อมูล" disabled={busy} onPress={() => {
              if (quickAddOpen) setQuickAddCategory(null);
              setQuickAddOpen((value) => !value);
            }} style={[local.attachButton, quickAddOpen && local.attachButtonActive, busy && local.disabled]}>
              <MaterialIcon color={quickAddOpen ? '#ffffff' : '#7a8a76'} name={quickAddOpen ? 'close' : 'add'} size={24} />
            </Touchable>
            <TextInput
              multiline
              onChangeText={setInput}
              onFocus={() => requestAnimationFrame(() => chatScrollRef.current?.scrollToEnd({animated: true}))}
              onSubmitEditing={() => sendMessage()}
              placeholder="ถาม AI หรือพูดกับไมค์..."
              placeholderTextColor="#8d9689"
              returnKeyType="send"
              style={local.input}
              value={input}
            />
            <Touchable accessibilityLabel={listening ? 'หยุดฟังเสียง' : 'พูดเพื่อพิมพ์'} disabled={busy} onPress={toggleVoiceInput} style={[local.voiceButton, listening && local.voiceButtonActive, busy && local.disabled]}>
              <MaterialIcon color={listening ? '#ffffff' : '#5d8059'} name={listening ? 'graphic_eq' : 'mic'} size={22} />
            </Touchable>
            <Touchable disabled={busy || !input.trim()} onPress={() => sendMessage()} style={[local.sendButton, (busy || !input.trim()) && local.disabled]}>
              <MaterialIcon color="#fff" name="send" size={22} />
            </Touchable>
          </View>
        </View>
      </View>
      </KeyboardAvoidingView>
      <Modal animationType="fade" onRequestClose={() => setNewChatMenuOpen(false)} transparent visible={newChatMenuOpen}>
        <Pressable onPress={() => setNewChatMenuOpen(false)} style={local.modalOverlay}>
          <Pressable onPress={(event) => event.stopPropagation()} style={local.modalSheet}>
            <View style={local.modalHandle} />
            <Text style={local.modalTitle}>เริ่มแชทใหม่</Text>
            <Text style={local.modalHint}>เลือกว่าจะเก็บบทสนทนานี้ไว้ในประวัติหรือไม่</Text>
            <Touchable onPress={() => startNewConversation('persistent')} style={local.modalOption}>
              <View style={local.modalOptionIcon}><MaterialIcon color="#5d8059" name="add_comment" size={21} /></View>
              <View style={{flex: 1}}><Text style={local.modalOptionTitle}>แชทใหม่</Text><Text style={local.modalOptionText}>บันทึกข้อความไว้ในประวัติของบัญชีนี้</Text></View>
              <MaterialIcon color="#9aa595" name="chevron_right" size={20} />
            </Touchable>
            <Touchable onPress={() => startNewConversation('temporary')} style={local.modalOption}>
              <View style={local.modalOptionIcon}><MaterialIcon color="#5d8059" name="timer" size={21} /></View>
              <View style={{flex: 1}}><Text style={local.modalOptionTitle}>แชทชั่วคราว</Text><Text style={local.modalOptionText}>ไม่บันทึกข้อความไว้ในประวัติหรือในเครื่อง</Text></View>
              <MaterialIcon color="#9aa595" name="chevron_right" size={20} />
            </Touchable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setChatHistoryOpen(false)} transparent visible={chatHistoryOpen}>
        <Pressable onPress={() => setChatHistoryOpen(false)} style={local.modalOverlay}>
          <Pressable onPress={(event) => event.stopPropagation()} style={[local.modalSheet, local.historySheet]}>
            <View style={local.modalHandle} />
            <View style={local.modalHeaderRow}>
              <View style={{flex: 1}}><Text style={local.modalTitle}>ประวัติแชท</Text><Text style={local.modalHint}>แตะเพื่อเปิดต่อ หรือลบรายการที่ไม่ต้องการ</Text></View>
              <Touchable onPress={() => setChatHistoryOpen(false)} style={local.modalClose}><MaterialIcon color="#5d6658" name="close" size={20} /></Touchable>
            </View>
            {chatHistoryLoading ? <ActivityIndicator color="#668d65" style={{marginVertical: 30}} /> : (
              <ScrollView contentContainerStyle={local.historyList} showsVerticalScrollIndicator={false}>
                {chatHistory.map((conversation) => (
                  <Touchable key={conversation.id} onPress={() => selectHistoryConversation(conversation)} style={local.historyItem}>
                    <View style={local.historyIcon}><MaterialIcon color="#5d8059" name="chat_bubble_outline" size={19} /></View>
                    <View style={{flex: 1}}>
                      <Text numberOfLines={1} style={local.historyTitle}>{conversation.title}</Text>
                      <Text numberOfLines={1} style={local.historyPreview}>{conversation.lastMessagePreview || `${conversation.messageCount} ข้อความ`}</Text>
                      <Text style={local.historyDate}>{formatDate(conversation.updatedAt.toISOString())}</Text>
                    </View>
                    <Touchable accessibilityLabel="ลบแชท" hitSlop={8} onPress={(event) => {event.stopPropagation(); setDeletingConversation(conversation);}} style={local.historyDelete}><MaterialIcon color="#9a6b6b" name="delete_outline" size={19} /></Touchable>
                  </Touchable>
                ))}
                {!chatHistory.length ? <View style={local.emptyHistory}><MaterialIcon color="#91a08d" name="history" size={34} /><Text style={local.modalOptionText}>ยังไม่มีแชทที่บันทึกไว้</Text></View> : null}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setOcrShortcutEditorOpen(false)} transparent visible={ocrShortcutEditorOpen}>
        <Pressable onPress={() => setOcrShortcutEditorOpen(false)} style={local.modalOverlay}>
          <Pressable onPress={(event) => event.stopPropagation()} style={[local.modalSheet, local.historySheet]}>
            <View style={local.modalHandle} />
            <View style={local.modalHeaderRow}>
              <View style={{flex: 1}}><Text style={local.modalTitle}>ตั้งค่าคำถามลัด OCR</Text><Text style={local.modalHint}>สร้างได้สูงสุด 4 รายการในหมวด OCR</Text></View>
              <Touchable onPress={() => setOcrShortcutEditorOpen(false)} style={local.modalClose}><MaterialIcon color="#5d6658" name="close" size={20} /></Touchable>
            </View>
            <ScrollView contentContainerStyle={local.shortcutEditorList} keyboardShouldPersistTaps="handled">
              {ocrShortcutDrafts.map((shortcut, index) => (
                <View key={`ocr-draft-${index}`} style={local.shortcutEditorCard}>
                  <View style={local.shortcutEditorHeader}><Text style={local.shortcutEditorNumber}>คำถามลัด {index + 1}</Text><Touchable onPress={() => setOcrShortcutDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}><MaterialIcon color="#9a6b6b" name="delete_outline" size={19} /></Touchable></View>
                  <TextInput maxLength={40} onChangeText={(title) => setOcrShortcutDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? {...item, title} : item))} placeholder="ชื่อปุ่ม เช่น ตรวจวันและปี" placeholderTextColor="#929b8f" style={local.shortcutEditorInput} value={shortcut.title} />
                  <TextInput maxLength={240} multiline onChangeText={(prompt) => setOcrShortcutDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? {...item, prompt} : item))} placeholder="คำถามที่จะส่งให้ AI" placeholderTextColor="#929b8f" style={[local.shortcutEditorInput, local.shortcutEditorPrompt]} value={shortcut.prompt} />
                </View>
              ))}
              {ocrShortcutDrafts.length < 4 ? <Touchable onPress={() => setOcrShortcutDrafts((current) => [...current, {detail: '', icon: 'document_scanner', prompt: '', title: ''}])} style={local.addShortcutButton}><MaterialIcon color="#5d8059" name="add" size={19} /><Text style={local.addShortcutText}>เพิ่มคำถามลัด</Text></Touchable> : null}
            </ScrollView>
            <Touchable onPress={saveOcrShortcutEditor} style={local.saveShortcutButton}><MaterialIcon color="#fff" name="check" size={19} /><Text style={local.quickAddCreateText}>บันทึกคำถามลัด</Text></Touchable>
          </Pressable>
        </Pressable>
      </Modal>
    </UserShell>
  );
}

const local = StyleSheet.create({
  actionConfirmButton: {alignItems: 'center', backgroundColor: '#557d52', borderRadius: 14, boxShadow: '0 7px 16px rgba(72,111,68,.22)', flex: 1.35, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 50, paddingHorizontal: 12},
  actionConfirmText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 13},
  addShortcutButton: {alignItems: 'center', borderColor: '#cddac9', borderRadius: 14, borderStyle: 'dashed', borderWidth: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 46},
  addShortcutText: {color: '#5d8059', fontFamily: 'Prompt_700Bold', fontSize: 12},
  actionCard: {alignSelf: 'stretch', marginTop: 8, padding: 14},
  actionDurationChip: {backgroundColor: '#ffffff', borderColor: '#dce7d8', borderRadius: 99, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6},
  actionDurationChipActive: {backgroundColor: '#668b62', borderColor: '#668b62'},
  actionDurationChipText: {color: '#63715f', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  actionDurationChipTextActive: {color: '#ffffff'},
  actionDurationOptions: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8},
  actionEditorDurationRow: {alignItems: 'flex-end', flexDirection: 'row', gap: 9},
  actionEditorError: {color: '#a05e5e', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, marginTop: 8},
  actionEditorField: {flex: 1.35},
  actionEditorFieldSmall: {flex: .8},
  actionEditorHint: {color: '#73806f', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 8},
  actionEditorHintBadge: {alignItems: 'center', backgroundColor: '#eaf3e7', borderRadius: 12, flexDirection: 'row', gap: 4, marginBottom: 1, paddingHorizontal: 8, paddingVertical: 8},
  actionEditorHintBadgeText: {color: '#587454', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  actionEditorInput: {backgroundColor: '#ffffff', borderColor: '#dce7d8', borderRadius: 12, borderWidth: 1, color: '#2d3a31', fontFamily: 'Prompt_600SemiBold', fontSize: 12, minHeight: 42, paddingHorizontal: 10, paddingVertical: 8},
  actionEditorLabel: {color: '#6f7c6b', fontFamily: 'Prompt_600SemiBold', fontSize: 12, marginBottom: 5},
  actionEditorPanel: {backgroundColor: '#f5f9f2', borderColor: '#dce8d7', borderRadius: 16, borderWidth: 1, marginTop: 8, padding: 11},
  actionPickerButton: {alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#dce7d8', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 6, minHeight: 42, paddingHorizontal: 9, paddingVertical: 8},
  actionPickerValue: {color: '#2d3a31', flex: 1, fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  actionEditorRow: {flexDirection: 'row', gap: 8, marginBottom: 9},
  actionEditorToggle: {alignItems: 'center', backgroundColor: '#eef5eb', borderColor: '#d8e5d4', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', minHeight: 44, paddingHorizontal: 10},
  actionEditorToggleActive: {backgroundColor: '#668b62', borderColor: '#668b62'},
  actionEditorToggleText: {color: '#547151', flex: 1, fontFamily: 'Prompt_700Bold', fontSize: 12},
  actionEditorToggleTextActive: {color: '#ffffff'},
  actionEditorWrap: {marginTop: 10},
  actionHeader: {alignItems: 'center', flexDirection: 'row', gap: 10},
  actionIcon: {alignItems: 'center', backgroundColor: '#e8f1e5', borderRadius: 18, height: 36, justifyContent: 'center', width: 36},
  assistantBubble: {backgroundColor: '#ffffff', borderColor: '#e4eadf', borderTopLeftRadius: 8, borderWidth: 1, boxShadow: '0 5px 14px rgba(45,58,49,.08)'},
  attachButton: {alignItems: 'center', backgroundColor: '#f0f2ee', borderRadius: 22, height: 42, justifyContent: 'center', width: 42},
  attachButtonActive: {backgroundColor: '#5d8059'},
  bubble: {borderRadius: 24, maxWidth: '88%', paddingHorizontal: 15, paddingVertical: 12},
  bubbleText: {color: '#2d3a31', fontFamily: 'Prompt_400Regular', fontSize: 14, lineHeight: 21},
  // Softened from #2b3916: the solid near-black fill made this button the
  // heaviest thing on the card, out-weighing the risk score it follows. #4a6b45
  // keeps white text at 6.03:1 (WCAG AA needs 4.5:1) -- the app's existing mid
  // greens (#5d8059, #618661) all fall just under 4.5:1 with white text.
  behaviorAction: {alignItems: 'center', backgroundColor: '#4a6b45', borderRadius: 14, flexDirection: 'row', gap: 7, justifyContent: 'center', marginTop: 12, minHeight: 43},
  behaviorActionText: {color: '#fff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  behaviorHeading: {alignItems: 'center', flexDirection: 'row', gap: 9},
  behaviorIcon: {alignItems: 'center', backgroundColor: '#e4eee3', borderRadius: 13, height: 34, justifyContent: 'center', width: 34},
  behaviorPanel: {backgroundColor: '#ffffff', borderRadius: 20, marginTop: 10, padding: 14},
  behaviorText: {color: '#7c8979', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  behaviorTiming: {flexDirection: 'row', gap: 8, marginTop: 11},
  behaviorTitle: {color: '#2d3a31', fontFamily: 'Prompt_800ExtraBold', fontSize: 13},
  burnoutIcon: {alignItems: 'center', backgroundColor: '#e8e9cc', borderRadius: 13, height: 34, justifyContent: 'center', width: 34},
  burnoutPanel: {alignItems: 'flex-start', backgroundColor: '#f0f1dc', borderColor: '#d9dcad', borderRadius: 18, borderWidth: 1, flexDirection: 'row', gap: 9, marginTop: 12, padding: 13},
  burnoutText: {color: '#727560', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  burnoutTitle: {color: '#35402d', fontFamily: 'Prompt_700Bold', fontSize: 12},
  chatContent: {gap: 14, paddingBottom: 138, paddingHorizontal: 18, paddingTop: 18},
  chatStack: {gap: 10},
  circleButton: {alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 12, height: 34, justifyContent: 'center', width: 34},
  composer: {alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#dfe7db', borderRadius: 30, borderWidth: 1, boxShadow: '0 8px 22px rgba(45,58,49,.12)', flexDirection: 'row', gap: 5, padding: 6},
  composerWrap: {bottom: 18, gap: 8, left: 18, position: 'absolute', right: 18, zIndex: 20},
  confirmRow: {alignItems: 'center', flexDirection: 'row', gap: 10, marginTop: 12},
  detailBox: {backgroundColor: '#f7f9f4', borderRadius: 14, gap: 8, marginTop: 12, padding: 12},
  detailLabel: {color: '#7d8779', fontFamily: 'Prompt_500Medium', fontSize: 12, width: 72},
  detailRow: {alignItems: 'flex-start', flexDirection: 'row', gap: 8},
  detailValue: {color: '#33412e', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18},
  disabled: {opacity: .5},
  emptyHistory: {alignItems: 'center', gap: 10, paddingVertical: 36},
  focusHeading: {color: '#2d3a31', fontFamily: 'Prompt_800ExtraBold', fontSize: 14, marginBottom: 8},
  focusCount: {color: '#668d65', fontFamily: 'Prompt_700Bold', fontSize: 12},
  focusHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 18},
  focusIcon: {alignItems: 'center', backgroundColor: '#e4eee3', borderRadius: 12, height: 30, justifyContent: 'center', width: 30},
  focusItem: {alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 16, flexDirection: 'row', gap: 9, padding: 10},
  focusItemTitle: {color: '#2d3a31', fontFamily: 'Prompt_700Bold', fontSize: 12},
  focusList: {gap: 8},
  focusSection: {marginTop: 10},
  focusText: {color: '#4b584e', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18},
  feedbackButton: {alignItems: 'center', backgroundColor: '#eef3eb', borderRadius: 14, height: 28, justifyContent: 'center', width: 30},
  feedbackButtonActive: {backgroundColor: '#668166'},
  feedbackButtonSpeaking: {backgroundColor: '#668166'},
  feedbackButtonNegative: {backgroundColor: '#a66e6e'},
  feedbackPrompt: {color: '#849080', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 12},
  feedbackRow: {alignItems: 'center', borderTopColor: '#edf0ea', borderTopWidth: 1, flexDirection: 'row', gap: 6, marginTop: 10, paddingTop: 8},
  heroCard: {alignItems: 'center', borderRadius: 24, flexDirection: 'row', gap: 12, minHeight: 122, overflow: 'hidden', padding: 17},
  heroCopy: {flex: 1, gap: 7},
  heroText: {color: 'rgba(255,255,255,.82)', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18},
  heroTitle: {color: '#ffffff', fontFamily: 'Prompt_800ExtraBold', fontSize: 21, lineHeight: 26},
  input: {color: '#2d3a31', flex: 1, fontFamily: 'Prompt_400Regular', fontSize: 14, maxHeight: 100, minHeight: 42, paddingHorizontal: 5, paddingVertical: 8},
  inputFade: {bottom: 0, height: 145, left: 0, position: 'absolute', right: 0},
  inlineAcceptButton: {alignItems: 'center', backgroundColor: '#587f55', borderRadius: 13, flex: 1.35, flexDirection: 'row', gap: 6, justifyContent: 'center', minHeight: 45, paddingHorizontal: 10},
  inlineAcceptText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  inlineAdaptiveActions: {flexDirection: 'row', gap: 8, marginTop: 12},
  inlineAdaptiveArrow: {alignItems: 'center', backgroundColor: '#e6f0e2', borderRadius: 16, height: 32, justifyContent: 'center', width: 32},
  inlineAdaptiveCard: {backgroundColor: 'rgba(255,255,255,.94)', borderColor: '#dfe9db', borderRadius: 20, borderWidth: 1, boxShadow: '0 6px 15px rgba(56,73,51,.08)', marginTop: 10, padding: 13},
  inlineAdaptiveCategory: {backgroundColor: '#e9f3e5', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 5},
  inlineAdaptiveCategoryText: {color: '#557451', fontFamily: 'Prompt_700Bold', fontSize: 12},
  inlineAdaptiveConfidence: {color: '#6f7f6c', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  inlineAdaptiveCount: {alignItems: 'center', backgroundColor: '#e6f0e2', borderRadius: 15, height: 30, justifyContent: 'center', width: 30},
  inlineAdaptiveCountText: {color: '#52734f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12},
  inlineAdaptiveHeader: {alignItems: 'center', flexDirection: 'row', gap: 9},
  inlineAdaptiveHeaderIcon: {alignItems: 'center', backgroundColor: '#5f845b', borderRadius: 16, height: 36, justifyContent: 'center', width: 36},
  inlineAdaptiveHeading: {color: '#2e3c2a', fontFamily: 'Prompt_800ExtraBold', fontSize: 14},
  inlineAdaptiveHint: {color: '#758272', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 1},
  inlineAdaptiveLearning: {color: '#70806c', fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18, marginTop: 7},
  inlineAdaptivePanel: {borderColor: '#dbe6d6', borderRadius: 24, borderWidth: 1, boxShadow: '0 8px 22px rgba(47,64,43,.09)', marginTop: 4, padding: 12},
  inlineAdaptiveReason: {backgroundColor: '#f2f7ef', borderRadius: 13, color: '#50604d', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 10, padding: 10},
  inlineAdaptiveTimeLabel: {color: '#8a9586', fontFamily: 'Prompt_500Medium', fontSize: 12},
  inlineAdaptiveTimeRow: {alignItems: 'center', backgroundColor: '#f7f9f5', borderRadius: 14, flexDirection: 'row', gap: 8, marginTop: 9, padding: 10},
  inlineAdaptiveTimeValue: {color: '#354431', fontFamily: 'Prompt_700Bold', fontSize: 12, lineHeight: 18, marginTop: 2},
  inlineAdaptiveTitle: {color: '#2d3a29', fontFamily: 'Prompt_800ExtraBold', fontSize: 14, marginTop: 9},
  inlineAdaptiveTitleRow: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  inlineAlternativeButton: {alignItems: 'center', backgroundColor: '#f3f6ef', borderColor: '#dce6d7', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 5, paddingHorizontal: 9, paddingVertical: 7},
  inlineAlternativeList: {flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9},
  inlineAlternativeText: {color: '#557052', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  inlineRejectButton: {alignItems: 'center', backgroundColor: '#edf1e9', borderRadius: 13, flex: 1, justifyContent: 'center', minHeight: 45, paddingHorizontal: 10},
  inlineRejectText: {color: '#687363', fontFamily: 'Prompt_700Bold', fontSize: 12},
  historyDate: {color: '#9aa296', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 3},
  historyDelete: {alignItems: 'center', backgroundColor: '#f7eeee', borderRadius: 15, height: 32, justifyContent: 'center', width: 32},
  historyIcon: {alignItems: 'center', backgroundColor: '#eaf2e7', borderRadius: 15, height: 40, justifyContent: 'center', width: 40},
  historyItem: {alignItems: 'center', borderBottomColor: '#e9eee5', borderBottomWidth: 1, flexDirection: 'row', gap: 10, paddingVertical: 12},
  historyList: {paddingBottom: 16},
  historyPreview: {color: '#778274', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2},
  historySheet: {maxHeight: '82%', minHeight: 360},
  historyTitle: {color: '#2d3a31', fontFamily: 'Prompt_700Bold', fontSize: 13},
  insightCount: {color: '#668d65', fontFamily: 'Prompt_700Bold', fontSize: 12},
  insightDivider: {backgroundColor: '#d9e0d3', borderRadius: 99, height: 5, marginTop: 8, width: '100%'},
  insightHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  insightHeading: {color: '#2d3a31', fontFamily: 'Prompt_800ExtraBold', fontSize: 14},
  insightSection: {marginTop: 16},
  keyboardAvoiding: {flex: 1},
  messageRow: {alignItems: 'flex-start'},
  messageRowUser: {alignItems: 'flex-end'},
  miniBrand: {color: '#668d65', fontFamily: 'Prompt_700Bold', fontSize: 12, lineHeight: 18},
  newChatPill: {alignItems: 'center', backgroundColor: '#4f7a52', borderRadius: 20, flexDirection: 'row', gap: 5, paddingHorizontal: 14, paddingVertical: 8},
  newChatPillDisabled: {alignItems: 'center', backgroundColor: '#4f7a52', borderRadius: 20, flexDirection: 'row', gap: 5, opacity: 0.45, paddingHorizontal: 14, paddingVertical: 8},
  newChatPillText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 13},
  modalClose: {alignItems: 'center', backgroundColor: '#eef2eb', borderRadius: 16, height: 34, justifyContent: 'center', width: 34},
  modalHandle: {alignSelf: 'center', backgroundColor: '#d4ddd0', borderRadius: 99, height: 4, marginBottom: 14, width: 42},
  modalHeaderRow: {alignItems: 'center', flexDirection: 'row', gap: 10},
  modalHint: {color: '#778274', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginBottom: 12, marginTop: 2},
  modalOption: {alignItems: 'center', backgroundColor: '#f8faf6', borderColor: '#e3eadf', borderRadius: 16, borderWidth: 1, flexDirection: 'row', gap: 11, marginTop: 8, minHeight: 68, padding: 11},
  modalOptionIcon: {alignItems: 'center', backgroundColor: '#e7f0e4', borderRadius: 16, height: 42, justifyContent: 'center', width: 42},
  modalOptionText: {color: '#7b8577', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  modalOptionTitle: {color: '#2d3a31', fontFamily: 'Prompt_700Bold', fontSize: 13},
  modalOverlay: {backgroundColor: 'rgba(31,38,29,.42)', flex: 1, justifyContent: 'flex-end'},
  modalSheet: {backgroundColor: '#ffffff', borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingBottom: 24, paddingHorizontal: 18, paddingTop: 10},
  modalTitle: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 18},
  pressed: {opacity: .7, transform: [{translateY: -1}]},
  pendingTaskButton: {alignItems: 'center', backgroundColor: '#5d8059', borderRadius: 12, flexDirection: 'row', gap: 5, justifyContent: 'center', minHeight: 38, paddingHorizontal: 10},
  pendingTaskButtonDone: {backgroundColor: '#e8f1e5', borderColor: '#cdddc9', borderWidth: 1},
  pendingTaskButtonText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  pendingTaskButtonTextDone: {color: '#5b7c57'},
  pendingTaskCopy: {flex: 1, minWidth: 0},
  pendingTaskDue: {color: '#7f8a7a', fontFamily: 'Prompt_400Regular', fontSize: 12, lineHeight: 18, marginTop: 2},
  pendingTaskList: {gap: 7, marginTop: 10},
  pendingTaskRow: {alignItems: 'center', backgroundColor: '#f5f8f2', borderColor: '#e0e8dc', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 9, padding: 9},
  pendingTaskTitle: {color: '#33412e', fontFamily: 'Prompt_700Bold', fontSize: 12, lineHeight: 18},
  quickAddCopy: {flex: 1, minWidth: 0},
  quickAddBack: {alignItems: 'center', backgroundColor: '#edf4ea', borderRadius: 14, height: 36, justifyContent: 'center', width: 36},
  quickAddCategoryHeader: {alignItems: 'center', flexDirection: 'row', gap: 9},
  quickAddCreate: {alignItems: 'center', backgroundColor: '#5d8059', borderRadius: 14, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 46, paddingHorizontal: 12},
  quickAddCreateText: {color: '#ffffff', fontFamily: 'Prompt_700Bold', fontSize: 12},
  quickAddDetail: {color: '#7d8878', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2},
  quickAddGrid: {gap: 8, marginTop: 10},
  quickAddHeader: {gap: 1},
  quickAddHint: {color: '#7b8876', fontFamily: 'Prompt_400Regular', fontSize: 12},
  quickAddIcon: {alignItems: 'center', backgroundColor: '#e9f2e6', borderRadius: 13, height: 38, justifyContent: 'center', width: 38},
  quickAddMenu: {borderColor: '#e1e8dc', borderRadius: 18, borderWidth: 1, boxShadow: '0 -8px 24px rgba(44, 52, 27, 0.11)', padding: 12},
  quickAddOption: {alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#e5eadf', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 54, padding: 8},
  quickAddOptionTitle: {color: '#29351f', fontFamily: 'Prompt_700Bold', fontSize: 13},
  quickAddTitle: {color: '#29351f', fontFamily: 'Prompt_800ExtraBold', fontSize: 14},
  screenTitle: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 19, lineHeight: 23},
  saveShortcutButton: {alignItems: 'center', backgroundColor: '#5d8059', borderRadius: 15, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 48, marginTop: 10},
  scrollToBottomButton: {alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#dce6d8', borderRadius: 22, borderWidth: 1, bottom: 94, boxShadow: '0 5px 16px rgba(45,58,49,.18)', height: 44, justifyContent: 'center', position: 'absolute', right: 24, width: 44, zIndex: 19},
  secondaryButton: {alignItems: 'center', backgroundColor: '#eef1eb', borderRadius: 14, justifyContent: 'center', marginTop: 15, minHeight: 50, paddingHorizontal: 15},
  secondaryButtonText: {color: '#66735f', fontFamily: 'Prompt_700Bold', fontSize: 14},
  sendButton: {alignItems: 'center', backgroundColor: '#4f7a52', borderRadius: 23, height: 46, justifyContent: 'center', width: 46},
  // Refactored UI: a single seamless surface fills the entire screen without an outer frame.
  shell: {backgroundColor: '#f4f7f4', flex: 1},
  shortcutCard: {alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 18, flexDirection: 'row', gap: 12, minHeight: 60, padding: 12, width: '100%'},
  shortcutCardAdaptive: {backgroundColor: '#eef6ea', borderColor: '#bfd2b9', borderWidth: 1},
  shortcutGrid: {gap: 8},
  shortcutSectionLabel: {color: '#7a8777', fontFamily: 'Prompt_700Bold', fontSize: 12, marginBottom: 8, marginTop: 16},
  shortcutEditorCard: {backgroundColor: '#f7faf5', borderColor: '#e2e9de', borderRadius: 16, borderWidth: 1, gap: 8, padding: 11},
  shortcutEditorHeader: {alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between'},
  shortcutEditorInput: {backgroundColor: '#ffffff', borderColor: '#dfe7db', borderRadius: 12, borderWidth: 1, color: '#2d3a31', fontFamily: 'Prompt_400Regular', fontSize: 12, minHeight: 42, paddingHorizontal: 11, paddingVertical: 8},
  shortcutEditorList: {gap: 10, paddingBottom: 8},
  shortcutEditorNumber: {color: '#4d634a', fontFamily: 'Prompt_700Bold', fontSize: 12},
  shortcutEditorPrompt: {minHeight: 66, textAlignVertical: 'top'},
  shortcutIcon: {alignItems: 'center', backgroundColor: '#eef5ed', borderRadius: 12, height: 36, justifyContent: 'center', width: 36},
  shortcutSubtitle: {color: '#8a9585', fontFamily: 'Prompt_400Regular', fontSize: 12, marginTop: 2},
  shortcutTitle: {color: '#26321f', fontFamily: 'Prompt_800ExtraBold', fontSize: 12},
  statusConfirmed: {backgroundColor: '#e8f1e5'},
  statusIcon: {alignItems: 'center', borderRadius: 15, height: 27, justifyContent: 'center', width: 27},
  statusIconConfirmed: {backgroundColor: '#5d8359'},
  statusIconRejected: {backgroundColor: '#9a6969'},
  statusPill: {alignItems: 'center', alignSelf: 'flex-start', borderRadius: 99, flexDirection: 'row', gap: 6, marginTop: 12, paddingHorizontal: 10, paddingVertical: 6},
  statusRejected: {backgroundColor: '#f4e9e9'},
  statusText: {fontFamily: 'Prompt_700Bold', fontSize: 12},
  statusTextConfirmed: {color: '#4f754b'},
  statusTextRejected: {color: '#8a5b5b'},
  suggestionChip: {alignItems: 'center', alignSelf: 'stretch', backgroundColor: '#f1f6ef', borderColor: '#dce8d8', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'space-between', minHeight: 40, paddingHorizontal: 12, paddingVertical: 8},
  suggestionList: {gap: 7, marginTop: 10},
  suggestionText: {color: '#52664f', flex: 1, fontFamily: 'Prompt_500Medium', fontSize: 12, lineHeight: 18},
  stopButton: {alignItems: 'center', backgroundColor: '#f2ece9', borderColor: '#e1d5cf', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 4, paddingHorizontal: 10, paddingVertical: 7},
  stopButtonText: {color: '#7d6a63', fontFamily: 'Prompt_600SemiBold', fontSize: 12},
  thinking: {alignItems: 'center', flexDirection: 'row', gap: 8, padding: 10},
  timingLabel: {color: '#7e8b7a', fontFamily: 'Prompt_500Medium', fontSize: 12},
  timingTile: {backgroundColor: '#f1f5ef', borderRadius: 14, flex: 1, padding: 10},
  timingValue: {color: '#34412e', fontFamily: 'Prompt_700Bold', fontSize: 12, marginTop: 2},
  temporaryBadge: {alignItems: 'center', backgroundColor: '#e8f1e5', borderRadius: 99, flexDirection: 'row', gap: 3, paddingHorizontal: 7, paddingVertical: 3},
  temporaryBadgeText: {color: '#5d8059', fontFamily: 'Prompt_700Bold', fontSize: 12},
  titleRow: {alignItems: 'center', flexDirection: 'row', gap: 7},
  topBar: {alignItems: 'center', flexDirection: 'row', gap: 9},
  topActions: {alignItems: 'center', flexDirection: 'row', gap: 6},
  topTitle: {flex: 1},
  userBubble: {backgroundColor: '#4f7a52', borderBottomRightRadius: 8, boxShadow: '0 4px 10px rgba(45,58,49,.14)'},
  userBubbleText: {color: '#ffffff'},
  voiceButton: {alignItems: 'center', backgroundColor: '#edf5ec', borderRadius: 22, height: 42, justifyContent: 'center', width: 42},
  voiceButtonActive: {backgroundColor: '#5d8059'},
});
