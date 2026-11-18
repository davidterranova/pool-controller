#pragma once
// See __init__.py: an update entity that mirrors `source` and hands installs
// to an automation instead of installing.

#include "esphome/components/update/update_entity.h"
#include "esphome/core/automation.h"
#include "esphome/core/component.h"
#include "esphome/core/defines.h"

namespace esphome::gated_update {

class GatedUpdate : public update::UpdateEntity, public Component {
 public:
  void set_source(update::UpdateEntity *source) { this->source_ = source; }
  Trigger<bool> *get_install_trigger() { return &this->install_trigger_; }

  void setup() override {
    // The installed version before any check (the source learns it from its
    // first manifest), so Home Assistant and the page show it from boot.
#ifdef ESPHOME_PROJECT_VERSION
    this->update_info_.current_version = ESPHOME_PROJECT_VERSION;
#endif
    this->source_->add_on_state_callback([this]() { this->mirror_(); });
    if (this->source_->has_state())
      this->mirror_();
    else
      this->publish_state();
  }

  /// Home Assistant's update.install, the page's « Installer »: the
  /// automation decides when the source installs.
  void perform(bool force) override { this->install_trigger_.trigger(force); }
  void check() override { this->source_->check(); }

 protected:
  void mirror_() {
    std::string installed = this->update_info_.current_version;
    this->update_info_ = this->source_->update_info;
    if (this->update_info_.current_version.empty())
      this->update_info_.current_version = installed;
    this->state_ = this->source_->state;
    this->publish_state();
  }

  update::UpdateEntity *source_{nullptr};
  Trigger<bool> install_trigger_;
};

}  // namespace esphome::gated_update
