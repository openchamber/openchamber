package com.openchamber.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SeenBannersTest {

    @Test
    public void matchesTheBannerTheViewListed() {
        SeenBanners seen = new SeenBanners();
        seen.add("ready-ses_a", 0, "41");

        assertTrue(seen.contains("ready-ses_a", 0, "41"));
    }

    @Test
    public void keepsANewerPushThatReplacedTheListedBanner() {
        SeenBanners seen = new SeenBanners();
        seen.add("ready-ses_a", 0, "41");

        assertFalse(seen.contains("ready-ses_a", 0, "42"));
    }

    @Test
    public void keepsANewerPushPostedAfterTheListButNotYetShown() {
        SeenBanners seen = new SeenBanners();
        seen.add("ready-ses_queued", 0, "41");
        SeenBanners.notePosted("ready-ses_queued", 0, "42");

        // The system still reports the listed push while the newer one is queued.
        assertFalse(seen.stillShows("ready-ses_queued", 0, "41"));
    }

    @Test
    public void removesTheListedPushWhenItWasTheLastOnePosted() {
        SeenBanners seen = new SeenBanners();
        seen.add("ready-ses_posted", 0, "41");
        SeenBanners.notePosted("ready-ses_posted", 0, "41");

        assertTrue(seen.stillShows("ready-ses_posted", 0, "41"));
        // A slot this process never posted to goes by what the system shows.
        seen.add("ready-ses_earlier", 0, "7");
        assertTrue(seen.stillShows("ready-ses_earlier", 0, "7"));
    }

    @Test
    public void neverMatchesABannerWithoutADeliveryId() {
        SeenBanners seen = new SeenBanners();
        seen.add("ready-ses_a", 0, null);

        assertTrue(seen.isEmpty());
        assertFalse(seen.contains("ready-ses_a", 0, null));
    }

    @Test
    public void tellsAnUntaggedSlotFromATaggedOne() {
        SeenBanners seen = new SeenBanners();
        seen.add(null, 7, "41");

        assertTrue(seen.contains(null, 7, "41"));
        assertFalse(seen.contains("", 7, "41"));
        assertFalse(seen.contains("ready-ses_a", 7, "41"));
    }
}
