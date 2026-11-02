package com.adb.stewart.ui;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.ContentFactory;
import org.jetbrains.annotations.NotNull;

public class ChatToolWindowFactory implements ToolWindowFactory {
    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        ChatPanel panel = new ChatPanel(project);
        com.intellij.ui.content.Content content = ContentFactory.getInstance().createContent(panel, "", false);
        Disposer.register(content, panel);
        toolWindow.getContentManager().addContent(content);
    }
}
