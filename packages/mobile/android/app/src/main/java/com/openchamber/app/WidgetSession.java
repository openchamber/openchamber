package com.openchamber.app;

/** One row of a widget's session list. */
public final class WidgetSession {

    public final String id;
    public final String title;
    public final boolean unread;
    public final String project;

    public WidgetSession(String id, String title, boolean unread, String project) {
        this.id = id;
        this.title = title;
        this.unread = unread;
        this.project = project;
    }

}
