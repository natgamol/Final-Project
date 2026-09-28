import {useCallback, useMemo, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {Touchable} from '@/components/touchable';
import {LinearGradient} from 'expo-linear-gradient';

import {
  RECOMMENDATION_SOURCES,
  RECOMMENDATION_STATUSES,
  summarizeRecommendations,
  type AdminRecommendationInput,
  type RecommendationStatus,
} from '@/admin/analytics';
import {adminCloud, type RecommendationAudit} from '@/services/admin-cloud';
import {MaterialIcon} from '@/screens/native/user/user-ui';
import {
  AdminCard, C, Empty, F, KindBadge, Row, SectionHead, StatTile, Tag,
  date, dateTimeFromMillis, items, money, strings, styles as ui, text,
} from '../admin-ui';
import type {AdminViewProps} from './view-props';

const KIND_BADGES: Record<string, [string, string]> = {
  burnout: ['Burnout', 'rose'],
  finance: ['Finance', 'amber'],
  note: ['Note', 'green'],
  priority: ['Priority', 'purple'],
  schedule: ['Schedule', 'green'],
};

const STATUS_BADGES: Record<string, [string, string]> = {
  accepted: ['ยอมรับแล้ว', 'green'],
  dismissed: ['ละทิ้ง', 'muted'],
  expired: ['หมดอายุ', 'muted'],
  new: ['ใหม่', 'purple'],
  seen: ['ผู้ใช้เห็นแล้ว', 'amber'],
};

const SOURCE_LABELS: Record<string, string> = {
  activity: 'กิจกรรม',
  behavior: 'พฤติกรรม',
  finance: 'การเงิน',
  note: 'โน้ต',
  schedule: 'ปฏิทิน / ตาราง',
};

const STATUS_LABELS: Record<RecommendationStatus, string> = {
  accepted: 'ยอมรับแล้ว',
  dismissed: 'ละทิ้ง',
  expired: 'หมดอายุ',
  new: 'ใหม่',
  seen: 'ผู้ใช้เห็นแล้ว',
};

const SOURCE_ICONS: Record<string, string> = {
  activity: 'task_alt',
  behavior: 'insights',
  finance: 'account_balance_wallet',
  note: 'sticky_note_2',
  schedule: 'calendar_month',
};

/**
 * Recommendations are written by two different producers: the seeded documents
 * use `explanation`, the adaptive ones use `detail`. Reading only the first is
 * what made a real item render its detail line as a bare "-".
 */
function explanationOf(item: Record<string, unknown>) {
  return text(item.explanation ?? item.detail, 'ไม่มีคำอธิบายจาก AI');
}

/**
 * Renders one real Firestore document from a context group.
 *
 * The collections differ in shape, so the row picks whichever recognised
 * fields exist rather than assuming a single schema.
 */
function ContextItem({item, timeField}: {item: Record<string, unknown>; timeField: string}) {
  const title = text(item.title ?? item.merchant ?? item.category ?? item.courseName, 'ไม่มีชื่อ');
  const amount = typeof item.amount === 'number' ? money(item.amount) : '';
  const when = date(item[timeField]);
  const body = text(item.content ?? item.note ?? item.location ?? item.courseCode, '');

  return (
    <View style={styles.contextItem}>
      <View style={styles.contextBullet} />
      <View style={{flex: 1}}>
        <View style={styles.contextItemHead}>
          <Text numberOfLines={2} style={styles.contextItemTitle}>{title}</Text>
          {amount ? <Text style={styles.contextAmount}>{amount}</Text> : null}
        </View>
        {body ? <Text numberOfLines={2} style={styles.contextItemBody}>{body}</Text> : null}
        <Text style={styles.contextItemMeta}>{`${timeField}: ${when}`}</Text>
      </View>
    </View>
  );
}

export default function AdminAiKnowledgeView({data}: AdminViewProps) {
  const list = items(data.recommendations);
  const [audit, setAudit] = useState<RecommendationAudit | null>(null);
  const [auditPath, setAuditPath] = useState<string | null>(null);
  const [auditError, setAuditError] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);

  const summary = useMemo(() => summarizeRecommendations(
    list.map((item) => ({
      contextSources: item.contextSources,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
      id: text(item.id, ''),
      kind: typeof item.kind === 'string' ? item.kind : null,
      read: item.read,
      status: typeof item.status === 'string' ? item.status : null,
      title: typeof item.title === 'string' ? item.title : null,
    }) satisfies AdminRecommendationInput),
  ), [list]);

  const openAudit = useCallback(async (path: string) => {
    setAuditPath(path);
    setAudit(null);
    setAuditError('');
    setAuditLoading(true);
    try {
      setAudit(await adminCloud.recommendationAudit(path));
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : 'ดึงข้อมูลต้นทางไม่สำเร็จ');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const closeAudit = useCallback(() => {
    setAuditPath(null);
    setAudit(null);
    setAuditError('');
  }, []);

  // Only statuses the data actually contains are worth a tile; the rest are
  // reported as an explicit coverage gap instead of a row of zeros.
  const presentStatuses = RECOMMENDATION_STATUSES.filter((status) => summary.statusCounts[status] > 0);
  const missingStatuses = summary.statusesWithoutData;

  return (
    <>
      <LinearGradient colors={['#777da5', '#9297bb']} style={ui.insight}>
        <MaterialIcon color="#fff" name="psychology" size={29} />
        <View style={{flex: 1}}>
          <Text style={ui.insightTitle}>AI Context Audit</Text>
          <Text style={ui.insightSub}>แตะคำแนะนำแต่ละรายการเพื่อดูข้อมูลจริงที่ AI ใช้ประกอบ</Text>
        </View>
      </LinearGradient>

      {/* 1 — Summary */}
      <AdminCard>
        <SectionHead meta={`${summary.total} รายการ`} title="1 · ภาพรวมคำแนะนำที่ยังใช้งานอยู่" />
        <View style={styles.tiles}>
          {RECOMMENDATION_SOURCES.map((source) => (
            <StatTile
              hint={SOURCE_LABELS[source]}
              key={source}
              label={source}
              tone={source === 'finance' ? 'amber' : source === 'note' ? 'green' : 'purple'}
              value={String(summary.sourceCounts[source])}
            />
          ))}
        </View>
        {summary.untaggedCount ? (
          <Text style={styles.note}>{`มี ${summary.untaggedCount} รายการที่ไม่ระบุแหล่งข้อมูล (contextSources ว่าง)`}</Text>
        ) : null}

        <View style={styles.divider} />

        <Text style={styles.subHead}>อัตราการยอมรับ / ละทิ้ง</Text>
        {summary.acceptanceRate === null ? (
          <View style={styles.warnBox}>
            <MaterialIcon color={C.amber} name="info" size={17} />
            <View style={{flex: 1}}>
              <Text style={styles.warnText}>
                ยังคำนวณไม่ได้ เพราะไม่มีคำแนะนำใดถูกบันทึกเป็น &quot;ยอมรับ&quot; หรือ &quot;ละทิ้ง&quot; เลย
              </Text>
              <Text style={styles.warnSub}>
                ไม่มีโค้ดส่วนใดในแอปเขียนค่าเหล่านี้กลับไปที่ aiRecommendations จึงไม่แสดง 0% ซึ่งจะสื่อว่าผู้ใช้ปฏิเสธทุกรายการ
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.tiles}>
            <StatTile hint={`จาก ${summary.decidedCount} รายการที่ตัดสินใจแล้ว`} label="ยอมรับ" tone="green"
              value={`${Math.round((summary.acceptanceRate ?? 0) * 100)}%`} />
            <StatTile hint={`จาก ${summary.decidedCount} รายการที่ตัดสินใจแล้ว`} label="ละทิ้ง" tone="rose"
              value={`${Math.round((summary.dismissalRate ?? 0) * 100)}%`} />
          </View>
        )}
      </AdminCard>

      {/* 3 — Lifecycle coverage */}
      <AdminCard>
        <SectionHead meta={`${presentStatuses.length}/${RECOMMENDATION_STATUSES.length} สถานะ`} title="2 · สถานะวงจรชีวิต" />
        {presentStatuses.length ? (
          <View style={styles.statusRow}>
            {presentStatuses.map((status) => (
              <View key={status} style={styles.statusChip}>
                <Text style={styles.statusChipValue}>{summary.statusCounts[status]}</Text>
                <Text style={styles.statusChipLabel}>{STATUS_LABELS[status]}</Text>
              </View>
            ))}
          </View>
        ) : <Empty label="ยังไม่มีคำแนะนำให้นับสถานะ" />}
        {summary.missingStatusCount ? (
          <View style={styles.warnBox}>
            <MaterialIcon color={C.amber} name="rule" size={17} />
            <View style={{flex: 1}}>
              <Text style={styles.warnText}>
                {`${summary.missingStatusCount} รายการไม่มีฟิลด์ status เลย`}
              </Text>
              <Text style={styles.warnSub}>
                ไม่นับรวมเป็น &quot;ใหม่&quot; เพราะระบบไม่เคยเขียนค่าไว้ — เป็นคนละกรณีกับที่ตั้งใจให้เป็นใหม่
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.statusRow}>
          <View style={styles.statusChip}>
            <Text style={styles.statusChipValue}>{summary.readCoverage.read}</Text>
            <Text style={styles.statusChipLabel}>อ่านแล้ว (read)</Text>
          </View>
          <View style={styles.statusChip}>
            <Text style={styles.statusChipValue}>{summary.readCoverage.unread}</Text>
            <Text style={styles.statusChipLabel}>ยังไม่อ่าน (read)</Text>
          </View>
          <View style={styles.statusChip}>
            <Text style={styles.statusChipValue}>{summary.readCoverage.missing}</Text>
            <Text style={styles.statusChipLabel}>ไม่มีฟิลด์ read</Text>
          </View>
        </View>

        {missingStatuses.length ? (
          <View style={styles.warnBox}>
            <MaterialIcon color={C.amber} name="report" size={17} />
            <View style={{flex: 1}}>
              <Text style={styles.warnText}>
                {`ไม่มีข้อมูลจริงสำหรับสถานะ: ${missingStatuses.map((status) => STATUS_LABELS[status]).join(', ')}`}
              </Text>
              <Text style={styles.warnSub}>
                แอปยังไม่เขียนสถานะเหล่านี้กลับไปที่ aiRecommendations จึงไม่แสดงตัวเลขสมมติ
              </Text>
            </View>
          </View>
        ) : null}
      </AdminCard>

      {/* 2 — Per-item audit */}
      <AdminCard>
        <SectionHead meta={`${list.length} รายการ`} title="3 · ตรวจสอบรายรายการ" />
        {list.length ? list.map((item) => {
          const path = text(item.path, '');
          const sources = strings(item.contextSources);
          return (
            <Row
              detail={`แหล่งข้อมูล: ${sources.map((source) => SOURCE_LABELS[source] ?? source).join(', ') || 'ไม่ระบุ'}`}
              icon="auto_awesome"
              key={text(item.id)}
              onPress={path ? () => { openAudit(path); } : undefined}
              title={text(item.title)}
              tone="purple"
            >
              <Text style={[ui.rowDetail, {color: '#6572b1', marginTop: 6}]}>{explanationOf(item)}</Text>
              <View style={styles.badges}>
                <KindBadge kind={text(item.kind, 'priority')} mapping={KIND_BADGES} />
                {typeof item.status === 'string' && item.status
                  ? <KindBadge kind={item.status} mapping={STATUS_BADGES} />
                  : <Tag backgroundColor={C.amberSoft} color="#8a6a24" label="ไม่มีฟิลด์ status" />}
                {item.read === true ? <Tag backgroundColor="#e7efe3" color={C.sage} label="อ่านแล้ว" /> : null}
                {item.read === false ? <Tag backgroundColor="#f1f4ed" color={C.muted} label="ยังไม่อ่าน" /> : null}
                <Tag backgroundColor="#f1f4ed" color={C.muted} label={date(item.createdAt)} />
              </View>
            </Row>
          );
        }) : <Empty label="ยังไม่มี AI Recommendation" />}
      </AdminCard>

      <Modal animationType="slide" onRequestClose={closeAudit} transparent visible={Boolean(auditPath)}>
        <View style={styles.backdrop}>
          <Pressable onPress={closeAudit} style={StyleSheet.absoluteFill} />
          <View accessibilityViewIsModal style={styles.sheet}>
            <View style={styles.sheetHead}>
              <View style={{flex: 1}}>
                <Text style={styles.sheetTitle}>ข้อมูลต้นทางของคำแนะนำ</Text>
                <Text style={styles.sheetSub}>{text(audit?.recommendation.title as string, 'กำลังโหลด...')}</Text>
              </View>
              <Touchable accessibilityLabel="ปิด" onPress={closeAudit} style={({pressed}) => [styles.close, pressed && ui.pressed]}>
                <MaterialIcon color={C.pine} name="close" size={20} />
              </Touchable>
            </View>

            <ScrollView contentContainerStyle={styles.sheetBody} showsVerticalScrollIndicator={false}>
              {auditLoading ? (
                <View style={styles.center}>
                  <ActivityIndicator color={C.sage} size="large" />
                  <Text style={styles.loadingText}>กำลังอ่านข้อมูลจริงจาก Firestore</Text>
                </View>
              ) : auditError ? (
                <View style={styles.warnBox}>
                  <MaterialIcon color={C.red} name="error" size={17} />
                  <Text style={[styles.warnText, {color: C.red}]}>{auditError}</Text>
                </View>
              ) : audit ? (
                <>
                  <View style={styles.provenance}>
                    <MaterialIcon color={C.amber} name="info" size={16} />
                    <Text style={styles.provenanceText}>
                      {audit.contextStoredOnDocument
                        ? 'ข้อมูลนี้ถูกบันทึกไว้พร้อมคำแนะนำตอนสร้าง'
                        : 'คำแนะนำไม่ได้บันทึก context ไว้ตอนสร้าง ข้อมูลด้านล่างจึงอ่านสดจากคอลเลกชันจริงของผู้ใช้ ในช่วงเวลารอบ ๆ วันที่สร้าง'}
                    </Text>
                  </View>

                  <View style={styles.metaBox}>
                    <Text style={styles.metaLine}>{`ผู้ใช้: ${audit.owner.displayName || audit.owner.email || audit.owner.uid}`}</Text>
                    <Text style={styles.metaLine}>{`สร้างเมื่อ: ${date(audit.recommendation.createdAt)}`}</Text>
                    <Text style={styles.metaLine}>
                      {`ช่วงข้อมูลที่ตรวจ: ${dateTimeFromMillis(audit.window.fromMillis)} — ${dateTimeFromMillis(audit.window.toMillis)}`}
                    </Text>
                    <Text style={styles.metaLine}>{`เหตุผลที่ AI ให้ไว้: ${explanationOf(audit.recommendation)}`}</Text>
                  </View>

                  {audit.contextGroups.length ? audit.contextGroups.map((group) => (
                    <View key={`${group.tag}-${group.collection}`} style={styles.group}>
                      <View style={styles.groupHead}>
                        <MaterialIcon color="#6572b1" name={SOURCE_ICONS[group.tag] ?? 'database'} size={17} />
                        <Text style={styles.groupTitle}>{group.label}</Text>
                        <Text style={styles.groupMeta}>{`${group.items.length} รายการ`}</Text>
                      </View>
                      {group.error ? (
                        <Text style={styles.groupError}>{`อ่านไม่สำเร็จ: ${group.error}`}</Text>
                      ) : group.items.length ? (
                        group.items.map((row, index) => (
                          <ContextItem item={row} key={text(row.id, String(index))} timeField={group.timeField} />
                        ))
                      ) : (
                        <Text style={styles.groupEmpty}>ไม่พบข้อมูลจริงในช่วงเวลานี้ — คำแนะนำอาจอ้างอิงข้อมูลที่ถูกลบไปแล้ว</Text>
                      )}
                    </View>
                  )) : (
                    <Text style={styles.groupEmpty}>คำแนะนำนี้ไม่ได้ระบุแหล่งข้อมูลใดไว้ จึงไม่มีอะไรให้ตรวจสอบ</Text>
                  )}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {backgroundColor: 'rgba(24,30,19,.48)', flex: 1, justifyContent: 'flex-end'},
  badges: {alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8},
  center: {alignItems: 'center', gap: 10, paddingVertical: 34},
  close: {alignItems: 'center', backgroundColor: '#eff3eb', borderRadius: 18, height: 36, justifyContent: 'center', width: 36},
  contextAmount: {color: C.pine, fontFamily: F.b, fontSize: 12},
  contextBullet: {backgroundColor: '#9297bb', borderRadius: 4, height: 8, marginTop: 5, width: 8},
  contextItem: {borderTopColor: '#eef1ea', borderTopWidth: 1, flexDirection: 'row', gap: 9, paddingVertical: 9},
  contextItemBody: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 2},
  contextItemHead: {alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'space-between'},
  contextItemMeta: {color: '#9aa396', fontFamily: F.m, fontSize: 12, marginTop: 3},
  contextItemTitle: {color: C.pine, flex: 1, fontFamily: F.s, fontSize: 12},
  divider: {backgroundColor: '#eef1ea', height: 1, marginVertical: 13},
  group: {backgroundColor: '#fbfcfa', borderColor: '#eef1ea', borderRadius: 14, borderWidth: 1, marginTop: 11, padding: 12},
  groupEmpty: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 8},
  groupError: {color: C.red, fontFamily: F.m, fontSize: 12, lineHeight: 18, marginTop: 6},
  groupHead: {alignItems: 'center', flexDirection: 'row', gap: 7},
  groupMeta: {color: C.muted, fontFamily: F.m, fontSize: 12},
  groupTitle: {color: C.pine, flex: 1, fontFamily: F.b, fontSize: 12},
  loadingText: {color: C.muted, fontFamily: F.m, fontSize: 12},
  metaBox: {backgroundColor: '#f6f8f3', borderRadius: 12, gap: 4, marginTop: 11, padding: 11},
  metaLine: {color: C.pine2, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  note: {color: C.muted, fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 9},
  provenance: {alignItems: 'flex-start', backgroundColor: C.amberSoft, borderRadius: 12, flexDirection: 'row', gap: 8, padding: 11},
  provenanceText: {color: '#8a6a24', flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
  sheet: {backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', paddingTop: 16},
  sheetBody: {paddingBottom: 30, paddingHorizontal: 18},
  sheetHead: {alignItems: 'center', flexDirection: 'row', gap: 10, paddingBottom: 12, paddingHorizontal: 18},
  sheetSub: {color: C.muted, fontFamily: F.m, fontSize: 12, marginTop: 2},
  sheetTitle: {color: C.pine, fontFamily: F.x, fontSize: 17},
  statusChip: {backgroundColor: '#f6f8f3', borderRadius: 12, flexGrow: 1, minWidth: 84, paddingHorizontal: 11, paddingVertical: 9},
  statusChipLabel: {color: C.muted, fontFamily: F.m, fontSize: 12, marginTop: 2},
  statusChipValue: {color: C.pine, fontFamily: F.x, fontSize: 17},
  statusRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  subHead: {color: C.pine, fontFamily: F.b, fontSize: 12, marginBottom: 8},
  tiles: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4},
  warnBox: {alignItems: 'flex-start', backgroundColor: C.amberSoft, borderRadius: 12, flexDirection: 'row', gap: 8, marginTop: 9, padding: 11},
  warnSub: {color: '#8a6a24', fontFamily: F.r, fontSize: 12, lineHeight: 18, marginTop: 3, opacity: 0.85},
  warnText: {color: '#8a6a24', flex: 1, fontFamily: F.m, fontSize: 12, lineHeight: 18},
});
