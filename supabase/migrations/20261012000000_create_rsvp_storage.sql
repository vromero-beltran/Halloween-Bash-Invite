create table public.potluck_options (
    value text primary key,
    label text not null,
    sort_order integer not null default 0,
    is_active boolean not null default true
);

insert into public.potluck_options (value, label, sort_order) values
    ('Tequila - Blanco', 'Tequila - Blanco', 1),
    ('Tequila - Añejo', 'Tequila - Añejo', 2),
    ('Vodka', 'Vodka', 3),
    ('Whiskey', 'Whiskey', 4),
    ('Chips and salsa', 'Chips and salsa', 5),
    ('Pizza', 'Pizza', 6),
    ('Charcuterie Board', 'Charcuterie Board', 7),
    ('Dessert 1', 'Dessert 1', 8),
    ('Dessert 2', 'Dessert 2', 9),
    ('Dessert 3', 'Dessert 3', 10),
    ('Non-alcoholic drinks', 'Non-alcoholic drinks', 11),
    ('Ice x3 bags', 'Ice x3 bags', 12),
    ('Mixers', 'Mixers', 13),
    ('Other', 'Other (requires host approval)', 14);

create table public.event_rsvps (
    id uuid primary key default gen_random_uuid(),
    edit_token_hash text not null unique,
    name text not null,
    email text not null,
    status text not null check (status in ('attending', 'maybe', 'declined')),
    potluck text not null references public.potluck_options(value),
    custom_potluck text not null default '',
    costume text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.potluck_reservations (
    reservation_key text primary key,
    rsvp_id uuid not null unique references public.event_rsvps(id) on delete cascade
);

alter table public.potluck_options enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.potluck_reservations enable row level security;

create or replace function public.save_event_rsvp(
    p_edit_token_hash text,
    p_name text,
    p_email text,
    p_status text,
    p_potluck text,
    p_custom_potluck text,
    p_costume text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_rsvp public.event_rsvps%rowtype;
    previous_values jsonb;
    selected_option public.potluck_options%rowtype;
    is_update boolean;
begin
    if p_edit_token_hash !~ '^[a-f0-9]{64}$' then
        return jsonb_build_object('ok', false, 'error', 'Invalid edit token.');
    end if;

    if p_status not in ('attending', 'maybe', 'declined') then
        return jsonb_build_object('ok', false, 'error', 'Invalid RSVP status.');
    end if;

    select * into selected_option
    from public.potluck_options
    where value = p_potluck and is_active;

    if not found then
        return jsonb_build_object('ok', false, 'error', 'That potluck option is no longer available.');
    end if;

    begin
        select * into current_rsvp
        from public.event_rsvps
        where edit_token_hash = p_edit_token_hash
        for update;

        is_update := found;

        if is_update then
            previous_values := jsonb_build_object(
                'name', current_rsvp.name,
                'email', current_rsvp.email,
                'status', current_rsvp.status,
                'potluck', current_rsvp.potluck,
                'customPotluck', current_rsvp.custom_potluck,
                'costume', current_rsvp.costume
            );
            delete from public.potluck_reservations
            where rsvp_id = current_rsvp.id;
        else
            insert into public.event_rsvps (
                edit_token_hash, name, email, status, potluck, custom_potluck, costume
            ) values (
                p_edit_token_hash, p_name, p_email, p_status, p_potluck,
                coalesce(p_custom_potluck, ''), coalesce(p_costume, '')
            )
            returning * into current_rsvp;
            previous_values := null;
        end if;

        insert into public.potluck_reservations (reservation_key, rsvp_id)
        values (
            case
                when p_potluck = 'Other' then
                    'Other:' || lower(regexp_replace(btrim(p_custom_potluck), '\s+', ' ', 'g'))
                else p_potluck
            end,
            current_rsvp.id
        );

        if is_update then
            update public.event_rsvps
            set name = p_name,
                email = p_email,
                status = p_status,
                potluck = p_potluck,
                custom_potluck = coalesce(p_custom_potluck, ''),
                costume = coalesce(p_costume, ''),
                updated_at = now()
            where id = current_rsvp.id
            returning * into current_rsvp;
        end if;

        return jsonb_build_object(
            'ok', true,
            'updated', is_update,
            'previous', previous_values,
            'rsvp', jsonb_build_object(
                'id', current_rsvp.id,
                'name', current_rsvp.name,
                'email', current_rsvp.email,
                'status', current_rsvp.status,
                'potluck', current_rsvp.potluck,
                'customPotluck', current_rsvp.custom_potluck,
                'costume', current_rsvp.costume
            )
        );
    exception
        when unique_violation then
            return jsonb_build_object(
                'ok', false,
                'error', 'That potluck choice was just claimed. Please choose another.'
            );
    end;
end;
$$;

revoke all on function public.save_event_rsvp(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_event_rsvp(text, text, text, text, text, text, text) to service_role;
