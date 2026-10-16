'use strict';
const PALETTE = ['E06C75', 'E5C07B', '56B6C2', 'C678DD', '61AFEF', '98C379', 'D19A66', 'BE5046', '7EC8E3', '9ECE6A', 'F7768E', 'FF9E64', '7AA2F7', 'BB9AF7', '73DACA', '2AC3DE', 'DB4B4B', 'E0AF68', '449DAB', 'A9DC76'];
function memberLabelDefinitions(members) {
  const used = new Set();
  const slugs = new Set();
  return members.map(member => {
    const slug = member.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug || slugs.has(slug)) throw new Error('Ambiguous squad member label slug');
    slugs.add(slug);
    let hash = 0;
    for (const char of slug) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
    let index = Math.abs(hash) % PALETTE.length;
    let attempts = 0;
    while (used.has(PALETTE[index]) && attempts++ < PALETTE.length) index = (index + 1) % PALETTE.length;
    used.add(PALETTE[index]);
    return { name: `squad:${slug}`, color: PALETTE[index], description: `Assigned to ${member.name} (${member.role})` };
  });
}
module.exports = { memberLabelDefinitions };
