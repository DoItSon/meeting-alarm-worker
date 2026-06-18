const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const messaging = admin.messaging();

async function checkAndSendAlarms() {
  const now = Date.now();

  // 등록된 FCM 토큰 가져오기
  const tokensSnap = await db.collection('fcm_tokens').get();
  const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
  if (tokens.length === 0) { console.log('등록된 토큰 없음'); return; }

  // 전체 회의 가져오기
  const meetingsSnap = await db.collection('meetings').get();
  const meetings = meetingsSnap.docs.map(d => d.data());

  // 이미 보낸 알람 목록
  const firedSnap = await db.collection('fired_alarms').get();
  const firedKeys = new Set(firedSnap.docs.map(d => d.id));

  const toFire = [];
  meetings.forEach(m => {
    if (!m.time || !m.date) return;
    const meetTime = new Date(`${m.date}T${m.time}`).getTime();
    if (meetTime < now) return;

    (m.alarms || [5, 10, 30]).forEach(min => {
      const alarmTime = meetTime - min * 60000;
      const key = `${m.id}_${min}`;
      // 알람 시간이 지났고(최대 6분 이내) 아직 안 보낸 경우 — 5분 간격 cron에 맞춤
      if (now >= alarmTime && now - alarmTime <= 6 * 60000 && !firedKeys.has(key)) {
        toFire.push({ meeting: m, minutesBefore: min, key });
      }
    });
  });

  console.log(`발송할 알람: ${toFire.length}개`);

  for (const { meeting, minutesBefore, key } of toFire) {
    const body = `${minutesBefore}분 후 시작: ${meeting.title}${meeting.location ? '\n📍 ' + meeting.location : ''}`;
    try {
      const res = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: '🔔 회의 알람', body },
        data: { tag: key }
      });
      console.log(`✅ ${meeting.title} — 성공:${res.successCount} 실패:${res.failureCount}`);

      // 발송 완료 기록 (2시간 후 자동 삭제)
      await db.collection('fired_alarms').doc(key).set({
        firedAt: admin.firestore.FieldValue.serverTimestamp(),
        meetingTitle: meeting.title
      });

      // 만료된 토큰 정리
      const invalidTokens = [];
      res.responses.forEach((r, i) => {
        if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(tokens[i]);
        }
      });
      for (const t of invalidTokens) {
        await db.collection('fcm_tokens').doc(t).delete();
        console.log('만료 토큰 삭제:', t.slice(0, 20) + '...');
      }
    } catch(e) {
      console.error('발송 실패:', e.message);
    }
  }

  // 2시간 지난 fired_alarms 정리
  const cutoff = new Date(now - 2 * 60 * 60 * 1000);
  const oldFired = await db.collection('fired_alarms')
    .where('firedAt', '<', cutoff).get();
  for (const doc of oldFired.docs) await doc.ref.delete();
}

checkAndSendAlarms()
  .then(() => { console.log('완료'); process.exit(0); })
  .catch(e => { console.error(e); process.exit(1); });
