-- Open Brain extensions schema (offline self-hosted build)
-- Upstream extension schema.sql files concatenated verbatim, prefixed with a
-- minimal Supabase auth shim so the RLS policies apply on plain PostgreSQL.
-- The MCP server connects as superuser (RLS bypassed); app-level user_id
-- filtering provides scoping in this single-user deployment.

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '{}'::jsonb $$;


-- ============================================================
-- Extension: household-knowledge
-- ============================================================
-- Extension 1: Household Knowledge Base
-- Schema for storing household facts and vendor contacts

-- Table: household_items
-- Stores facts about things in your home (paint colors, appliances, measurements, etc.)
CREATE TABLE IF NOT EXISTS household_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    category TEXT, -- e.g. 'paint', 'appliance', 'measurement', 'document'
    location TEXT, -- where in the home this item is
    details JSONB DEFAULT '{}', -- flexible metadata (model numbers, colors, specs, etc.)
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: household_vendors
-- Tracks service providers (plumbers, electricians, landscapers, etc.)
CREATE TABLE IF NOT EXISTS household_vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    service_type TEXT, -- e.g. 'plumber', 'electrician', 'landscaper'
    phone TEXT,
    email TEXT,
    website TEXT,
    notes TEXT,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    last_used DATE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_household_items_user_category
    ON household_items(user_id, category);

CREATE INDEX IF NOT EXISTS idx_household_vendors_user_service
    ON household_vendors(user_id, service_type);

-- Row Level Security (RLS) policies
-- Enable RLS on both tables
ALTER TABLE household_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_vendors ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own household items
CREATE POLICY household_items_user_policy ON household_items
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only see their own vendors
CREATE POLICY household_vendors_user_policy ON household_vendors
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on household_items
DROP TRIGGER IF EXISTS update_household_items_updated_at ON household_items;
CREATE TRIGGER update_household_items_updated_at
    BEFORE UPDATE ON household_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO household_items (user_id, name, category, location, details, notes) VALUES
-- (auth.uid(), 'Living Room Paint', 'paint', 'Living Room', '{"brand": "Sherwin Williams", "color": "Sea Salt", "code": "SW 6204"}', 'Purchased 2 gallons in March 2025'),
-- (auth.uid(), 'Dishwasher', 'appliance', 'Kitchen', '{"brand": "Bosch", "model": "SHPM65Z55N", "serial": "FD12345678", "purchase_date": "2024-06-15"}', 'Still under warranty until June 2026');

-- ============================================================
-- Extension: home-maintenance
-- ============================================================
-- Extension 2: Home Maintenance Tracker
-- Schema for tracking maintenance tasks and logging completed work

-- Table: maintenance_tasks
-- Recurring or one-time maintenance items
CREATE TABLE IF NOT EXISTS maintenance_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    category TEXT, -- e.g. 'hvac', 'plumbing', 'exterior', 'appliance', 'landscaping'
    frequency_days INTEGER, -- null for one-time tasks; e.g. 90 for quarterly, 365 for annual
    last_completed TIMESTAMPTZ, -- when was this last done
    next_due TIMESTAMPTZ, -- when is it due next
    priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: maintenance_logs
-- History of completed maintenance work
CREATE TABLE IF NOT EXISTS maintenance_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES maintenance_tasks(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    performed_by TEXT, -- who did the work (self, vendor name, etc.)
    cost DECIMAL(10, 2), -- cost in dollars (or your currency)
    notes TEXT,
    next_action TEXT -- what the tech/contractor recommended for next time
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_user_next_due
    ON maintenance_tasks(user_id, next_due);

CREATE INDEX IF NOT EXISTS idx_maintenance_logs_task_completed
    ON maintenance_logs(task_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_maintenance_logs_user_completed
    ON maintenance_logs(user_id, completed_at DESC);

-- Row Level Security (RLS) policies
ALTER TABLE maintenance_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own maintenance tasks
CREATE POLICY maintenance_tasks_user_policy ON maintenance_tasks
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can only see their own maintenance logs
CREATE POLICY maintenance_logs_user_policy ON maintenance_logs
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp on maintenance_tasks
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update updated_at on maintenance_tasks
DROP TRIGGER IF EXISTS update_maintenance_tasks_updated_at ON maintenance_tasks;
CREATE TRIGGER update_maintenance_tasks_updated_at
    BEFORE UPDATE ON maintenance_tasks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to update task's last_completed and next_due after logging maintenance
-- This trigger runs when a new maintenance_log is inserted
CREATE OR REPLACE FUNCTION update_task_after_maintenance_log()
RETURNS TRIGGER AS $$
DECLARE
    task_frequency INTEGER;
BEGIN
    -- Get the frequency_days from the associated task
    SELECT frequency_days INTO task_frequency
    FROM maintenance_tasks
    WHERE id = NEW.task_id;

    -- Update the task's last_completed and next_due
    UPDATE maintenance_tasks
    SET
        last_completed = NEW.completed_at,
        next_due = CASE
            WHEN task_frequency IS NOT NULL THEN NEW.completed_at + (task_frequency || ' days')::INTERVAL
            ELSE NULL
        END,
        updated_at = now()
    WHERE id = NEW.task_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update parent task when maintenance is logged
DROP TRIGGER IF EXISTS update_task_after_log ON maintenance_logs;
CREATE TRIGGER update_task_after_log
    AFTER INSERT ON maintenance_logs
    FOR EACH ROW
    EXECUTE FUNCTION update_task_after_maintenance_log();

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO maintenance_tasks (user_id, name, category, frequency_days, next_due, priority, notes) VALUES
-- (auth.uid(), 'HVAC Filter Replacement', 'hvac', 90, now() + INTERVAL '90 days', 'medium', 'Use 16x25x1 pleated filters'),
-- (auth.uid(), 'Gutter Cleaning', 'exterior', 180, now() + INTERVAL '180 days', 'medium', 'Best to do before rainy season'),
-- (auth.uid(), 'Water Heater Inspection', 'plumbing', 365, now() + INTERVAL '365 days', 'low', 'Check for leaks and sediment buildup');

-- ============================================================
-- Extension: family-calendar
-- ============================================================
-- Extension 3: Family Calendar
-- Multi-person family scheduling system

-- Family members in your household
CREATE TABLE family_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    relationship TEXT, -- e.g. 'self', 'spouse', 'child', 'parent'
    birth_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Scheduled events and recurring activities
CREATE TABLE activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    family_member_id UUID REFERENCES family_members, -- null means whole family
    title TEXT NOT NULL,
    activity_type TEXT, -- e.g. 'sports', 'medical', 'school', 'social'
    day_of_week TEXT, -- for recurring: 'monday', 'tuesday', etc. null for one-time
    start_time TIME,
    end_time TIME,
    start_date DATE,
    end_date DATE, -- null for one-time or ongoing recurring
    location TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Birthdays, anniversaries, deadlines
CREATE TABLE important_dates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    family_member_id UUID REFERENCES family_members, -- null for family-wide dates
    title TEXT NOT NULL,
    date_value DATE NOT NULL,
    recurring_yearly BOOLEAN DEFAULT false,
    reminder_days_before INTEGER DEFAULT 7,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_activities_user_dow ON activities(user_id, day_of_week);
CREATE INDEX idx_activities_family_member ON activities(family_member_id);
CREATE INDEX idx_activities_user_dates ON activities(user_id, start_date, end_date);
CREATE INDEX idx_important_dates_user_date ON important_dates(user_id, date_value);
CREATE INDEX idx_family_members_user ON family_members(user_id);

-- ============================================================
-- Extension: meal-planning
-- ============================================================
-- Extension 4: Meal Planning
-- Complete meal planning system with RLS for shared household access

-- Recipe collection
CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    cuisine TEXT,
    prep_time_minutes INTEGER,
    cook_time_minutes INTEGER,
    servings INTEGER,
    ingredients JSONB NOT NULL DEFAULT '[]', -- array of {name, quantity, unit}
    instructions JSONB NOT NULL DEFAULT '[]', -- array of step strings
    tags TEXT[] DEFAULT '{}',
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Weekly meal planning
CREATE TABLE meal_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    week_start DATE NOT NULL, -- should be a Monday
    day_of_week TEXT NOT NULL, -- 'monday', 'tuesday', etc.
    meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    recipe_id UUID REFERENCES recipes,
    custom_meal TEXT, -- for meals without a recipe
    servings INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Auto-generated or manual grocery lists
CREATE TABLE shopping_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    week_start DATE NOT NULL,
    items JSONB NOT NULL DEFAULT '[]', -- array of {name, quantity, unit, purchased: bool, recipe_id}
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_recipes_user_cuisine ON recipes(user_id, cuisine);
CREATE INDEX idx_recipes_user_tags ON recipes USING GIN (tags);
CREATE INDEX idx_meal_plans_user_week ON meal_plans(user_id, week_start);
CREATE INDEX idx_shopping_lists_user_week ON shopping_lists(user_id, week_start);

-- Enable Row Level Security
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;

-- RLS Policies for recipes
CREATE POLICY "Users can CRUD their own recipes"
    ON recipes
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Household members can view recipes"
    ON recipes
    FOR SELECT
    USING (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    );

-- RLS Policies for meal_plans
CREATE POLICY "Users can CRUD their own meal plans"
    ON meal_plans
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Household members can view meal plans"
    ON meal_plans
    FOR SELECT
    USING (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    );

-- RLS Policies for shopping_lists
CREATE POLICY "Users can CRUD their own shopping lists"
    ON shopping_lists
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Household members can view shopping lists"
    ON shopping_lists
    FOR SELECT
    USING (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    );

CREATE POLICY "Household members can update shopping lists"
    ON shopping_lists
    FOR UPDATE
    USING (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    )
    WITH CHECK (
        auth.jwt() ->> 'role' = 'household_member'
        OR auth.uid() = user_id
    );

-- ============================================================
-- Extension: professional-crm
-- ============================================================
-- Extension 5: Professional CRM
-- Schema for tracking professional contacts, interactions, and opportunities

-- Table: professional_contacts
-- People in your professional network
CREATE TABLE IF NOT EXISTS professional_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    company TEXT,
    title TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    how_we_met TEXT,
    tags TEXT[] DEFAULT '{}',
    notes TEXT,
    last_contacted TIMESTAMPTZ,
    follow_up_date DATE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: contact_interactions
-- Log of every touchpoint with contacts
CREATE TABLE IF NOT EXISTS contact_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id UUID REFERENCES professional_contacts(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    interaction_type TEXT NOT NULL CHECK (interaction_type IN ('meeting', 'email', 'call', 'coffee', 'event', 'linkedin', 'other')),
    occurred_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    summary TEXT NOT NULL,
    follow_up_needed BOOLEAN DEFAULT false,
    follow_up_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: opportunities
-- Deals, projects, or potential collaborations
CREATE TABLE IF NOT EXISTS opportunities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    contact_id UUID REFERENCES professional_contacts(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    stage TEXT DEFAULT 'identified' CHECK (stage IN ('identified', 'in_conversation', 'proposal', 'negotiation', 'won', 'lost')),
    value DECIMAL(12,2),
    expected_close_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_professional_contacts_user_last_contacted
    ON professional_contacts(user_id, last_contacted);

CREATE INDEX IF NOT EXISTS idx_professional_contacts_follow_up
    ON professional_contacts(user_id, follow_up_date)
    WHERE follow_up_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contact_interactions_contact_occurred
    ON contact_interactions(contact_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_opportunities_user_stage
    ON opportunities(user_id, stage);

-- Row Level Security (RLS)
ALTER TABLE professional_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only see their own data
CREATE POLICY professional_contacts_user_policy ON professional_contacts
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY contact_interactions_user_policy ON contact_interactions
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY opportunities_user_policy ON opportunities
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update updated_at columns
DROP TRIGGER IF EXISTS update_professional_contacts_updated_at ON professional_contacts;
CREATE TRIGGER update_professional_contacts_updated_at
    BEFORE UPDATE ON professional_contacts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_opportunities_updated_at ON opportunities;
CREATE TRIGGER update_opportunities_updated_at
    BEFORE UPDATE ON opportunities
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to auto-update last_contacted when an interaction is logged
CREATE OR REPLACE FUNCTION update_last_contacted()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE professional_contacts
    SET last_contacted = NEW.occurred_at
    WHERE id = NEW.contact_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update last_contacted on new interactions
DROP TRIGGER IF EXISTS update_contact_last_contacted ON contact_interactions;
CREATE TRIGGER update_contact_last_contacted
    AFTER INSERT ON contact_interactions
    FOR EACH ROW
    EXECUTE FUNCTION update_last_contacted();

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO professional_contacts (user_id, name, company, title, email, how_we_met, tags) VALUES
-- (auth.uid(), 'Sarah Chen', 'DataCorp', 'VP of Engineering', 'sarah@datacorp.com', 'AI Summit 2026', ARRAY['ai', 'engineering']);

-- ============================================================
-- Extension: job-hunt
-- ============================================================
-- Extension 6: Job Hunt Pipeline
-- Schema for tracking job search: companies, postings, applications, interviews, contacts

-- Table: companies
-- Organizations you're tracking in your job search
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    name TEXT NOT NULL,
    industry TEXT,
    website TEXT,
    size TEXT CHECK (size IN ('startup', 'mid-market', 'enterprise') OR size IS NULL),
    location TEXT,
    remote_policy TEXT CHECK (remote_policy IN ('remote', 'hybrid', 'onsite') OR remote_policy IS NULL),
    notes TEXT,
    glassdoor_rating DECIMAL(2,1) CHECK (glassdoor_rating >= 1.0 AND glassdoor_rating <= 5.0 OR glassdoor_rating IS NULL),
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_postings
-- Specific roles at companies
CREATE TABLE IF NOT EXISTS job_postings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    salary_min INTEGER,
    salary_max INTEGER,
    salary_currency TEXT DEFAULT 'USD',
    requirements TEXT[],
    nice_to_haves TEXT[],
    notes TEXT,
    source TEXT CHECK (source IN ('linkedin', 'company-site', 'referral', 'recruiter', 'other') OR source IS NULL),
    posted_date DATE,
    closing_date DATE,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: applications
-- Your submitted applications
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_posting_id UUID REFERENCES job_postings(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    status TEXT DEFAULT 'applied' CHECK (status IN ('draft', 'applied', 'screening', 'interviewing', 'offer', 'accepted', 'rejected', 'withdrawn')),
    applied_date DATE,
    response_date DATE,
    resume_version TEXT,
    cover_letter_notes TEXT,
    referral_contact TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: interviews
-- Scheduled and completed interviews
CREATE TABLE IF NOT EXISTS interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES applications(id) ON DELETE CASCADE NOT NULL,
    user_id UUID NOT NULL,
    interview_type TEXT CHECK (interview_type IN ('phone_screen', 'technical', 'behavioral', 'system_design', 'hiring_manager', 'team', 'final')),
    scheduled_at TIMESTAMPTZ,
    duration_minutes INTEGER,
    interviewer_name TEXT,
    interviewer_title TEXT,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    notes TEXT, -- pre-interview prep notes
    feedback TEXT, -- post-interview reflection
    rating INTEGER CHECK (rating >= 1 AND rating <= 5 OR rating IS NULL), -- your assessment of how it went
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Table: job_contacts
-- People associated with your job search
CREATE TABLE IF NOT EXISTS job_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    title TEXT,
    email TEXT,
    phone TEXT,
    linkedin_url TEXT,
    role_in_process TEXT CHECK (role_in_process IN ('recruiter', 'hiring_manager', 'referral', 'interviewer', 'other') OR role_in_process IS NULL),
    professional_crm_contact_id UUID, -- FK to Extension 5's professional_contacts table (not enforced by DB, managed by application)
    notes TEXT,
    last_contacted TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_companies_user_id
    ON companies(user_id);

CREATE INDEX IF NOT EXISTS idx_job_postings_company_id
    ON job_postings(company_id);

CREATE INDEX IF NOT EXISTS idx_applications_user_status
    ON applications(user_id, status);

CREATE INDEX IF NOT EXISTS idx_applications_job_posting
    ON applications(job_posting_id);

CREATE INDEX IF NOT EXISTS idx_interviews_application_scheduled
    ON interviews(application_id, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_interviews_user_scheduled
    ON interviews(user_id, scheduled_at)
    WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_job_contacts_user_company
    ON job_contacts(user_id, company_id);

-- Row Level Security (RLS)
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_contacts ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can only see their own data
CREATE POLICY companies_user_policy ON companies
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY job_postings_user_policy ON job_postings
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY applications_user_policy ON applications
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY interviews_user_policy ON interviews
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY job_contacts_user_policy ON job_contacts
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update updated_at columns
DROP TRIGGER IF EXISTS update_companies_updated_at ON companies;
CREATE TRIGGER update_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_applications_updated_at ON applications;
CREATE TRIGGER update_applications_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Sample data (optional - uncomment to insert examples)
-- INSERT INTO companies (user_id, name, industry, size, remote_policy) VALUES
-- (auth.uid(), 'TechCorp', 'Enterprise Software', 'enterprise', 'remote');
