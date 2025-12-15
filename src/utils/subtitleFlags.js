function isTrueishFlag(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }
  return false;
}

function isHearingImpairedSubtitle(sub) {
  if (!sub) return false;
  return (
    isTrueishFlag(sub.hearing_impaired) ||
    isTrueishFlag(sub.hearingImpaired) ||
    isTrueishFlag(sub.hi)
  );
}

function inferHearingImpairedFromName(name) {
  if (!name) return false;
  const s = String(name).toLowerCase();
  if (/(^|[\s._\-\[(])sdh($|[\s._\-\])])/.test(s)) return true;
  if (/hearing[\s._-]*impaired/.test(s)) return true;
  if (/closed[\s._-]*captions/.test(s)) return true;
  if (/(^|[\s._\-\[(])cc($|[\s._\-\])])/.test(s)) return true;
  return false;
}

module.exports = {
  isTrueishFlag,
  isHearingImpairedSubtitle,
  inferHearingImpairedFromName
};
