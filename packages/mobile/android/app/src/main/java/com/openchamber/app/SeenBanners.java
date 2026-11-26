package com.openchamber.app;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * The banners a view saw, each named by its slot (tag and id) and by the push
 * it showed (`nid`). Android reuses the slot for a newer push about the same
 * thing, so a banner replaced after the view listed it carries another nid and
 * is not one of these. A banner without a nid cannot be told from its
 * replacement and is never matched; the server's clearing push covers it.
 *
 * The system shows a post a moment after `notify` returns, so the active
 * notifications can still name the replaced push. Posts and removals hold
 * {@link #LOCK}, and a post records its nid first: a removal then checks the
 * push the slot last got, and a post after it lands after the cancel.
 */
final class SeenBanners {

    static final Object LOCK = new Object();

    // slot -> the nid of the last push this process posted there ("" for none).
    private static final Map<String, String> posted = new HashMap<>();

    private final Set<String> keys = new HashSet<>();

    /** Call while holding {@link #LOCK}, right before posting to the slot. */
    static void notePosted(String tag, int id, String nid) {
        posted.put(slotOf(tag, id), nid == null ? "" : nid);
    }

    void add(String tag, int id, String nid) {
        String key = keyOf(tag, id, nid);
        if (key != null) keys.add(key);
    }

    boolean isEmpty() {
        return keys.isEmpty();
    }

    boolean contains(String tag, int id, String nid) {
        String key = keyOf(tag, id, nid);
        return key != null && keys.contains(key);
    }

    /** Whether the slot, showing `shownNid` to the system, still holds a push the view saw. Call while holding {@link #LOCK}. */
    boolean stillShows(String tag, int id, String shownNid) {
        String latest = posted.get(slotOf(tag, id));
        return contains(tag, id, latest != null ? latest : shownNid);
    }

    private static String slotOf(String tag, int id) {
        return (tag == null ? "" : "t:" + tag) + "\n" + id;
    }

    private static String keyOf(String tag, int id, String nid) {
        if (nid == null || nid.isEmpty()) return null;
        return slotOf(tag, id) + "\n" + nid;
    }
}
