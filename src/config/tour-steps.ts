export type TourTabKey = 'dashboard' | 'finance' | 'calendar' | 'scan' | 'assistant';

export type TourStep = {
  id: string;
  title: string;
  description: string;
  /** Corner radius of the highlight ring. Use 999 for a circular/pill target. */
  radius?: number;
};

/**
 * One short spotlight tour per bottom tab, shown the first time that tab is
 * opened. Kept to buttons that are always mounted (not behind scan/save
 * results) so the tour never points at something that is not on screen yet.
 */
export const TOUR_STEPS: Record<TourTabKey, TourStep[]> = {
  dashboard: [
    {
      id: 'bell',
      title: 'การแจ้งเตือน',
      description: 'แตะตรงนี้เพื่อดูการแจ้งเตือนงาน กำหนดส่ง และรายการเงินที่ AI อ่านให้อัตโนมัติ',
      radius: 999,
    },
    {
      id: 'ai-card',
      title: 'ผู้ช่วย AI',
      description: 'ถามอะไรก็ได้เกี่ยวกับตารางเรียนหรือเงินของคุณ พิมพ์หรือพูดใส่ก็ได้',
      radius: 20,
    },
    {
      id: 'weekly-spending',
      title: 'สรุปรายจ่ายสัปดาห์นี้',
      description: 'ดูภาพรวมค่าใช้จ่ายของสัปดาห์นี้แบบเร็วๆ แตะ "ดูทั้งหมด" เพื่อดูรายละเอียด',
      radius: 14,
    },
  ],
  finance: [
    {
      id: 'period-tabs',
      title: 'มุมมองวัน / สัปดาห์ / เดือน',
      description: 'สลับดูรายรับ-รายจ่ายเป็นรายวัน รายสัปดาห์ หรือรายเดือนได้ตรงนี้',
      radius: 14,
    },
    {
      id: 'range-bar',
      title: 'เลื่อนดูช่วงเวลา',
      description: 'กดลูกศรเพื่อย้อนดูช่วงก่อนหน้า หรือแตะตรงกลางเพื่อกลับมาช่วงปัจจุบัน',
      radius: 14,
    },
  ],
  calendar: [
    {
      id: 'import-schedule',
      title: 'นำเข้าตารางเรียน',
      description: 'ถ่ายรูปหรือเลือกรูปตารางเรียน ให้ AI แปลงเป็นตารางในปฏิทินให้อัตโนมัติ',
      radius: 999,
    },
  ],
  scan: [
    {
      id: 'add-document',
      title: 'สแกนเอกสาร',
      description: 'ถ่ายภาพหรือเลือกรูปใบเสร็จ ตารางเรียน หรือเอกสารอื่นๆ ให้ AI อ่านข้อมูลให้',
      radius: 999,
    },
  ],
  assistant: [
    {
      id: 'new-chat',
      title: 'เริ่มแชทใหม่',
      description: 'เริ่มบทสนทนาใหม่กับ AI ได้ตลอดเวลา เลือกเก็บประวัติหรือคุยแบบชั่วคราวก็ได้',
      radius: 999,
    },
    {
      id: 'composer',
      title: 'พิมพ์หรือพูดกับ AI',
      description: 'พิมพ์ข้อความ แตะไมค์เพื่อพูด หรือกดส่งเพื่อคุยกับผู้ช่วย AI',
      radius: 24,
    },
  ],
};

export const TOUR_TAB_KEYS: TourTabKey[] = ['dashboard', 'finance', 'calendar', 'scan', 'assistant'];
