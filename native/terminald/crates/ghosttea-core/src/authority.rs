//! Multi-view attachment, control, resize, and input-deduplication policy.

use std::collections::HashMap;

use anyhow::{Result, bail};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerState {
    pub view_id: String,
    pub client_id: String,
    pub control_epoch: u64,
}

#[derive(Clone, Debug)]
struct AttachedView {
    client_id: String,
    access: ViewAccess,
    attachment_epoch: u64,
    last_input_sequence: u64,
    last_resize_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlChanged {
    pub controller: ControllerState,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
    pub size_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparedResize {
    resize_sequence: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
    size_changed: bool,
}

impl PreparedResize {
    pub fn layout_epoch(self) -> u64 {
        self.layout_epoch
    }

    pub fn size_changed(self) -> bool {
        self.size_changed
    }
}

#[derive(Clone, Debug)]
pub struct ViewAuthority {
    views: HashMap<String, AttachedView>,
    controller: Option<ControllerState>,
    next_control_epoch: u64,
    next_attachment_epoch: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
}

impl ViewAuthority {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            views: HashMap::new(),
            controller: None,
            next_control_epoch: 0,
            next_attachment_epoch: 0,
            cols,
            rows,
            layout_epoch: 1,
        }
    }

    pub fn attach(&mut self, view_id: &str, client_id: &str, access: ViewAccess) -> Result<u64> {
        if view_id.is_empty() || view_id.len() > 128 {
            bail!("invalid view id");
        }
        if let Some(existing) = self.views.get(view_id) {
            if existing.client_id == client_id {
                return Ok(existing.attachment_epoch);
            }
            bail!("view id is already attached by another client");
        }
        self.next_attachment_epoch = self.next_attachment_epoch.saturating_add(1);
        let attachment_epoch = self.next_attachment_epoch;
        self.views.insert(
            view_id.to_owned(),
            AttachedView {
                client_id: client_id.to_owned(),
                access,
                attachment_epoch,
                last_input_sequence: 0,
                last_resize_sequence: 0,
            },
        );
        Ok(attachment_epoch)
    }

    pub fn detach(&mut self, view_id: &str, client_id: &str) -> bool {
        let owned = self
            .views
            .get(view_id)
            .is_some_and(|view| view.client_id == client_id);
        if !owned {
            return false;
        }
        self.views.remove(view_id);
        if self
            .controller
            .as_ref()
            .is_some_and(|controller| controller.view_id == view_id)
        {
            self.controller = None;
        }
        true
    }

    pub fn claim_control(
        &mut self,
        view_id: &str,
        client_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ControlChanged> {
        let view = self.require_view(view_id, client_id)?;
        if view.access != ViewAccess::ReadWrite {
            bail!("read-only view cannot control terminal size");
        }
        self.next_control_epoch = self.next_control_epoch.saturating_add(1);
        let controller = ControllerState {
            view_id: view_id.to_owned(),
            client_id: client_id.to_owned(),
            control_epoch: self.next_control_epoch,
        };
        self.controller = Some(controller.clone());
        let size_changed = (self.cols, self.rows) != (cols, rows);
        if size_changed {
            self.cols = cols;
            self.rows = rows;
            self.layout_epoch = self.layout_epoch.saturating_add(1);
        }
        Ok(ControlChanged {
            controller,
            cols: self.cols,
            rows: self.rows,
            layout_epoch: self.layout_epoch,
            size_changed,
        })
    }

    pub fn authorize_resize(
        &mut self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let Some(prepared) = self.prepare_resize(
            view_id,
            client_id,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        self.commit_resize(view_id, prepared);
        Ok(prepared.size_changed)
    }

    pub fn prepare_resize(
        &self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<Option<PreparedResize>> {
        let authorized = self.controller.as_ref().is_some_and(|controller| {
            controller.view_id == view_id
                && controller.client_id == client_id
                && controller.control_epoch == control_epoch
        });
        if !authorized {
            bail!("stale or unauthorized resize controller");
        }
        let view = self.require_view(view_id, client_id)?;
        if resize_sequence <= view.last_resize_sequence {
            return Ok(None);
        }
        let size_changed = (self.cols, self.rows) != (cols, rows);
        Ok(Some(PreparedResize {
            resize_sequence,
            cols,
            rows,
            layout_epoch: if size_changed {
                self.layout_epoch.saturating_add(1)
            } else {
                self.layout_epoch
            },
            size_changed,
        }))
    }

    pub fn commit_resize(&mut self, view_id: &str, prepared: PreparedResize) {
        let view = self
            .views
            .get_mut(view_id)
            .expect("prepared resize view must remain attached while authority is locked");
        view.last_resize_sequence = prepared.resize_sequence;
        if prepared.size_changed {
            self.cols = prepared.cols;
            self.rows = prepared.rows;
            self.layout_epoch = prepared.layout_epoch;
        }
    }

    pub fn authorize_input(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
    ) -> Result<bool> {
        let view = self.require_view_mut(view_id, client_id)?;
        if view.access != ViewAccess::ReadWrite {
            bail!("view is read-only");
        }
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        if input_sequence <= view.last_input_sequence {
            return Ok(false);
        }
        view.last_input_sequence = input_sequence;
        Ok(true)
    }

    pub fn controller(&self) -> Option<&ControllerState> {
        self.controller.as_ref()
    }

    pub fn layout_epoch(&self) -> u64 {
        self.layout_epoch
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn has_views(&self) -> bool {
        !self.views.is_empty()
    }

    fn require_view(&self, view_id: &str, client_id: &str) -> Result<&AttachedView> {
        let view = self
            .views
            .get(view_id)
            .ok_or_else(|| anyhow::anyhow!("view is not attached"))?;
        if view.client_id != client_id {
            bail!("view belongs to another client");
        }
        Ok(view)
    }

    fn require_view_mut(&mut self, view_id: &str, client_id: &str) -> Result<&mut AttachedView> {
        let view = self
            .views
            .get_mut(view_id)
            .ok_or_else(|| anyhow::anyhow!("view is not attached"))?;
        if view.client_id != client_id {
            bail!("view belongs to another client");
        }
        Ok(view)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_authority_processed_claim_wins_and_stale_resize_fails() {
        let mut authority = ViewAuthority::new(80, 24);
        authority
            .attach("a", "client-a", ViewAccess::ReadWrite)
            .unwrap();
        authority
            .attach("b", "client-b", ViewAccess::ReadWrite)
            .unwrap();
        let a = authority.claim_control("a", "client-a", 100, 30).unwrap();
        let b = authority.claim_control("b", "client-b", 120, 40).unwrap();
        assert!(b.controller.control_epoch > a.controller.control_epoch);
        assert!(
            authority
                .authorize_resize("a", "client-a", a.controller.control_epoch, 1, 90, 20)
                .is_err()
        );
        assert_eq!(authority.size(), (120, 40));
        let reclaimed = authority.claim_control("a", "client-a", 100, 30).unwrap();
        assert!(
            authority
                .authorize_resize(
                    "a",
                    "client-a",
                    reclaimed.controller.control_epoch,
                    1,
                    101,
                    31,
                )
                .unwrap()
        );
    }

    #[test]
    fn input_is_deduplicated_per_attachment() {
        let mut authority = ViewAuthority::new(80, 24);
        let epoch = authority
            .attach("a", "client", ViewAccess::ReadWrite)
            .unwrap();
        assert!(authority.authorize_input("a", "client", epoch, 1).unwrap());
        assert!(!authority.authorize_input("a", "client", epoch, 1).unwrap());
        assert!(
            authority
                .authorize_input("a", "client", epoch + 1, 2)
                .is_err()
        );
    }

    #[test]
    fn detaching_controller_keeps_size_and_clears_controller() {
        let mut authority = ViewAuthority::new(80, 24);
        authority
            .attach("a", "client", ViewAccess::ReadWrite)
            .unwrap();
        authority.claim_control("a", "client", 100, 30).unwrap();
        assert!(authority.detach("a", "client"));
        assert!(authority.controller().is_none());
        assert_eq!(authority.size(), (100, 30));
    }
}
